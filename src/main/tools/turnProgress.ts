import type { ToolKind } from '@shared/tools.types'

/**
 * What one generation turn has actually *done*, as opposed to what the model
 * says it has done.
 *
 * This started as a single `madeChange` flag guarding `finish_goal` against a
 * fabricated completion (observed directly: a local model claimed "Created
 * hello2.txt" three turns running without ever calling `write_file`). It now
 * also carries enough ordering to answer a second question the flag could not:
 * *was the evidence gathered after the change it supposedly verifies?*
 *
 * Ordering is tracked with a monotonic counter rather than timestamps. Two
 * calls can share a millisecond, and the only thing anyone needs to know here
 * is which came first.
 */
export interface TurnProgress {
  /**
   * Whether a tool call that did real work has succeeded this turn. Excludes
   * `read` and `plan` kinds: reading is not doing, and neither is writing down
   * an intention, so `write_plan`/`update_plan_step` must not be able to
   * satisfy a completion claim on their own.
   */
  madeChange: boolean
  /** Monotonic sequence of successful tool calls, used only for ordering. */
  completedCalls: number
  /** Sequence number of the last successful change, or null if none. */
  lastChangeAt: number | null
  /** Sequence number of the last successful visual inspection, or null if none. */
  lastVisualInspectionAt: number | null
}

/**
 * Kinds that do not count as carrying out a goal. Reading is not doing, and
 * neither is writing down an intention — so `write_plan`/`update_plan_step`
 * cannot let `finish_goal` declare the work done, and `finish_goal` is
 * `plan`-kind itself, which is what stops it satisfying its own precondition.
 * Everything else counts: fetching a page is real work a goal can genuinely
 * need.
 */
const NON_WORK_KINDS = new Set<ToolKind>(['read', 'plan'])

/**
 * Kinds that can change what a page renders, which is a strictly narrower
 * question than "was this real work". `web` is real work but cannot alter the
 * workspace, so a `fetch_url` between an edit and a screenshot must not
 * invalidate that screenshot. `mcp` is included deliberately: an MCP server's
 * tools are opaque to us and may well write files, and over-demanding fresh
 * evidence is the safe direction for a verification gate.
 */
const RENDER_AFFECTING_KINDS = new Set<ToolKind>(['write', 'command', 'mcp'])

export function createTurnProgress(): TurnProgress {
  return {
    madeChange: false,
    completedCalls: 0,
    lastChangeAt: null,
    lastVisualInspectionAt: null
  }
}

/**
 * Record one successful tool call. Called from `runReadTool`/`runGuardedTool`
 * (see `helpers.ts`) for every call that completes without error.
 */
export function recordCompletedCall(
  progress: TurnProgress,
  spec: { name: string; kind: ToolKind }
): void {
  progress.completedCalls++
  if (!NON_WORK_KINDS.has(spec.kind)) progress.madeChange = true
  if (RENDER_AFFECTING_KINDS.has(spec.kind)) progress.lastChangeAt = progress.completedCalls
  if (spec.name === 'inspect_visual') {
    progress.lastVisualInspectionAt = progress.completedCalls
  }
}

/**
 * Whether a visual inspection has run since the most recent change.
 *
 * A turn that changed nothing cannot have invalidated an earlier inspection,
 * so any successful inspection counts there — this only demands re-inspection
 * where something actually moved underneath it.
 */
export function hasPostChangeVisualEvidence(progress: TurnProgress): boolean {
  if (progress.lastVisualInspectionAt === null) return false
  if (progress.lastChangeAt === null) return true
  return progress.lastVisualInspectionAt > progress.lastChangeAt
}
