import type { ToolCall, ToolKind } from '@shared/tools.types'
import { isObservationalRunCommand } from './commandEffect'

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

/**
 * Whether a call only looked at something.
 *
 * `kind` alone is not enough: `run_command` is a `command` whatever it did, so
 * a `sed -n '1,40p'` would otherwise read as work. Kept here, beside the kind
 * sets it belongs with, so the bounded runner's recovery accounting and the
 * continuation brief cannot drift apart about what counts as reading.
 */
export function isReadLikeCall(call: Pick<ToolCall, 'name' | 'kind' | 'title'>): boolean {
  return call.kind === 'read' || isObservationalRunCommand(call)
}

/**
 * Carried ordering from an earlier context epoch of the same bounded reply.
 *
 * A context epoch resets the model's request history, not the work already
 * done. Without a seed the fresh `TurnProgress` says `madeChange: false`, so
 * `finish_goal` refuses a goal whose work genuinely completed in the previous
 * epoch and tells the model to "create or edit a file, run a command" — an
 * instruction to repeat a mutation, produced by the transition itself. Seeding
 * is what keeps the evidence gate measuring the *task* rather than the epoch.
 */
export type TurnProgressSeed = Readonly<TurnProgress>

/**
 * `completedCalls` is a monotonic sequence, so a seed has to carry the counter
 * as well as the two sequence values that index into it. Restarting the counter
 * at zero while seeding `lastChangeAt: 12` would make every new call in this
 * epoch compare as *older* than the carried change, and
 * `hasPostChangeVisualEvidence` would then never return true again.
 */
export function createTurnProgress(seed?: TurnProgressSeed): TurnProgress {
  if (!seed) {
    return {
      madeChange: false,
      completedCalls: 0,
      lastChangeAt: null,
      lastVisualInspectionAt: null
    }
  }
  const completedCalls = Math.max(
    0,
    seed.completedCalls,
    seed.lastChangeAt ?? 0,
    seed.lastVisualInspectionAt ?? 0
  )
  return {
    madeChange: seed.madeChange,
    completedCalls,
    lastChangeAt: seed.lastChangeAt,
    lastVisualInspectionAt: seed.lastVisualInspectionAt
  }
}

/**
 * Rebuild the ledger from the settled tool calls of a whole bounded reply.
 *
 * The bounded runner keeps every settled call in insertion (settlement) order
 * across continuation cycles, but the live `TurnProgress` lives inside one
 * generation's tool context and is gone once that generation returns. Deriving
 * the seed here — rather than in the runner — is what stops the two from
 * drifting: `NON_WORK_KINDS` and `RENDER_AFFECTING_KINDS` are applied exactly
 * once, in the same file that defines them, so a kind added to either set
 * cannot be silently missed by the epoch path.
 */
export function progressFromSettledCalls(calls: readonly ToolCall[]): TurnProgress {
  const progress = createTurnProgress()
  for (const call of calls) {
    if (call.status !== 'success' || call.madeProgress === false) continue
    recordCompletedCall(progress, call)
  }
  return progress
}

/**
 * A seed carrying only the fact that this task has already had real work done
 * on it, from the settled tool calls of earlier turns.
 *
 * `finish_goal`'s first gate asks whether a completion claim has real action
 * behind it. `TurnProgress` answers that for one generation, which is the right
 * scope inside a single reply and the wrong one across an agent run's turns:
 * `AgentRunService` calls `runGeneration` once per turn, so a run that did its
 * work in turn 3 begins turn 4 with `madeChange: false`. `CONTINUE_PROMPT` then
 * asks it to call `finish_goal` if the goal is complete, and the gate refuses —
 * telling it to "create or edit a file, run a command" when the work is already
 * done. The only ways out are to manufacture a redundant mutation or to burn
 * the remaining turns.
 *
 * Measured across the stored runs: five refusals of exactly this shape, in five
 * different runs. Two never recovered; one ended with its plan at 0/5 having
 * spent the rest of its budget after the refusal.
 *
 * This is the argument `TurnProgressSeed` already makes for a context epoch,
 * applied to the boundary that also needed it. Deriving the answer from history
 * rather than threading an accumulator through the service is what makes it
 * survive a resumed run, where an in-memory counter would not.
 *
 * Only `madeChange` carries, because only `madeChange` is a fact about the
 * *task*. The ordering fields stay fresh: `hasStaleVisualEvidence` asks whether
 * this generation's evidence is current, and no measured failure asks for that
 * question to change scope. Widening it here would tighten a second gate that
 * nothing has complained about.
 */
export function priorTaskProgress(
  history: readonly { toolCalls?: readonly ToolCall[] }[]
): TurnProgressSeed | undefined {
  for (const turn of history) {
    for (const call of turn.toolCalls ?? []) {
      if (call.status !== 'success' || call.madeProgress === false) continue
      if (NON_WORK_KINDS.has(call.kind)) continue
      return {
        madeChange: true,
        completedCalls: 0,
        lastChangeAt: null,
        lastVisualInspectionAt: null
      }
    }
  }
  return undefined
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

/**
 * Whether this turn holds a visual inspection that a later change invalidated.
 *
 * Distinct from `hasPostChangeVisualEvidence`, and the distinction is the whole
 * point: that predicate is false when nothing was ever inspected, which is also
 * true of every task that has nothing to do with pixels. This one is true only
 * when the turn *did* look at rendered output and then changed something
 * afterwards — the exact state in which a completion claim is unsupported, and
 * the state a wording check on the summary was previously standing in for.
 */
export function hasStaleVisualEvidence(progress: TurnProgress): boolean {
  return (
    progress.lastVisualInspectionAt !== null &&
    progress.lastChangeAt !== null &&
    progress.lastChangeAt > progress.lastVisualInspectionAt
  )
}
