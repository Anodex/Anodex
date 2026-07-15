import { randomUUID } from 'node:crypto'
import type { ToolCall, ToolKind } from '@shared/tools.types'

/**
 * Surfaces provisional "running" tool calls while the model is still
 * *generating* a file write/edit's parameters - the slow part of a mutation
 * turn. Without this, a `ToolCall` only exists once execution starts, and for
 * local file writes execution takes milliseconds: the user watches a long
 * silent stretch while the model generates the file content, then the card
 * flashes from running to success in one frame.
 *
 * The executor claims the provisional id (`claim`), so the real
 * running/success/error emits update the same transcript card in place - the
 * card the user watched fill in during generation simply resolves.
 *
 * Only the file-content tools are tracked: their params are long (whole file
 * bodies) and their target path streams first, so a provisional card is both
 * useful and accurate. Every other tool generates its params near-instantly,
 * where a provisional card would just double the emit traffic.
 */

const TRACKED_TOOLS: Record<string, { verb: string; kind: ToolKind }> = {
  write_file: { verb: 'Write', kind: 'write' },
  edit_file: { verb: 'Edit', kind: 'write' },
  patch_file: { verb: 'Patch', kind: 'write' }
}

/** How much leading params text to scan for the target path before giving up
 *  (and to stop buffering - file bodies can be arbitrarily large). */
const PATH_SCAN_CAP = 4096

/** The subset of node-llama-cpp's params-chunk callback payload we consume. */
export interface PendingParamsChunk {
  callIndex: number
  functionName: string
  paramsChunk: string
}

interface PendingEntry {
  id: string
  name: string
  round: number
  callIndex: number
  verb: string
  kind: ToolKind
  paramsText: string
  path: string | null
  claimed: boolean
}

/** The params stream is JSON; the target path is an early string field. */
function extractPathParam(text: string): string | null {
  const match = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
  if (!match) return null
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return match[1]
  }
}

export class PendingToolCallTracker {
  private entries: PendingEntry[] = []

  /**
   * Digest one streamed params chunk. Returns a ToolCall to surface in the UI
   * when something meaningful changed (the call started, or its target path
   * just became parseable), else null.
   */
  onParamsChunk(round: number, chunk: PendingParamsChunk): ToolCall | null {
    const spec = TRACKED_TOOLS[chunk.functionName]
    if (!spec) return null

    let entry = this.entries.find((e) => e.round === round && e.callIndex === chunk.callIndex)
    const started = !entry
    if (!entry) {
      entry = {
        id: randomUUID(),
        name: chunk.functionName,
        round,
        callIndex: chunk.callIndex,
        verb: spec.verb,
        kind: spec.kind,
        paramsText: '',
        path: null,
        claimed: false
      }
      this.entries.push(entry)
    }

    let pathJustFound = false
    if (entry.path === null && entry.paramsText.length < PATH_SCAN_CAP) {
      entry.paramsText += chunk.paramsChunk
      const path = extractPathParam(entry.paramsText)
      if (path !== null) {
        entry.path = path
        entry.paramsText = '' // path found - no reason to keep buffering
        pathJustFound = true
      }
    }

    if (!started && !pathJustFound) return null
    return this.toCall(entry, 'running')
  }

  /**
   * Hand the provisional id for the next unclaimed call of this tool to its
   * executor, so the real emits take over the same transcript card. Calls are
   * claimed in generation order, which is also execution order.
   */
  claim(name: string): string | undefined {
    const entry = this.entries.find((e) => !e.claimed && e.name === name)
    if (!entry) return undefined
    entry.claimed = true
    return entry.id
  }

  /**
   * Finalize a finished round: any provisional card whose call never executed
   * (generation aborted mid-call) must not be left spinning forever. Returns
   * the terminal updates to emit.
   */
  sweep(round: number): ToolCall[] {
    const dangling = this.entries.filter((e) => e.round === round && !e.claimed)
    for (const entry of dangling) entry.claimed = true
    return dangling.map((entry) => ({
      ...this.toCall(entry, 'error'),
      detail: 'Interrupted'
    }))
  }

  /** Terminal updates for every remaining unclaimed provisional card, for the
   *  generation's final cleanup path (hard throws that skip per-round sweeps). */
  sweepAll(): ToolCall[] {
    const rounds = [...new Set(this.entries.filter((e) => !e.claimed).map((e) => e.round))]
    return rounds.flatMap((round) => this.sweep(round))
  }

  private toCall(entry: PendingEntry, status: ToolCall['status']): ToolCall {
    return {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      title: `${entry.verb} ${entry.path ?? '...'}`,
      status
    }
  }
}
