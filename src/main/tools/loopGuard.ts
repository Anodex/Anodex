/**
 * Per-generation guard against a model calling the exact same tool with the
 * exact same arguments over and over without making progress. Observed
 * directly: a local reasoning model called find_skill with an identical
 * query 672 times in a single turn, filling the entire context window until
 * node-llama-cpp's own context-shift recovery failed and force-ended the
 * turn with zero real work done. Keyed on `name` + `title` since that's the
 * only call-identifying data available at the runReadTool/runGuardedTool
 * boundary — every tool factory already interpolates its meaningful
 * argument(s) into `title` for the UI, so it doubles as a stable call
 * signature without threading raw args through every tool's handler.
 */
export interface LoopGuardState {
  counts: Map<string, number>
}

export function createLoopGuardState(): LoopGuardState {
  return { counts: new Map() }
}

/** Calls beyond this many identical repeats in one generation are blocked. */
export const LOOP_GUARD_LIMIT = 3

/**
 * If a model keeps repeating the exact same call even after being blocked
 * and told to stop, generation is force-aborted once the total attempt count
 * reaches this many — rather than trusting the model to eventually listen.
 * Observed directly: blocking the call (see `LOOP_GUARD_LIMIT`) stopped the
 * wasted backend work, but the model kept re-issuing the identical blocked
 * call anyway — 205 times in a row — until the context window itself ran
 * out, which is the exact failure this guard exists to prevent. A couple of
 * ignored nudges are tolerated (a model may need one retry to adjust
 * course); this many in a row means it isn't reacting to the message at all.
 */
export const LOOP_GUARD_ABORT_AFTER = LOOP_GUARD_LIMIT + 3

/**
 * Record an attempted call and report whether it should be blocked, and
 * whether generation should be force-aborted outright. Mutates
 * `state.counts` — call once per attempted tool invocation, before running it.
 */
export function checkLoopGuard(
  state: LoopGuardState,
  name: string,
  title: string
): { blocked: boolean; shouldAbort: boolean; count: number } {
  const key = `${name}::${title}`
  const count = (state.counts.get(key) ?? 0) + 1
  state.counts.set(key, count)
  return {
    blocked: count > LOOP_GUARD_LIMIT,
    shouldAbort: count >= LOOP_GUARD_ABORT_AFTER,
    count
  }
}

/** The model-facing message returned instead of actually running a blocked call. */
export function loopGuardMessage(name: string, count: number, aborting: boolean): string {
  const base =
    `You've already called ${name} with identical arguments ${count} times this turn ` +
    'without new results — this looks like a loop, not progress. Stop repeating this exact ' +
    'call. Try different arguments, use a different tool, or explain to the user what is ' +
    'blocking you instead.'
  return aborting
    ? `${base} Generation is being stopped now because this kept repeating after being told to stop.`
    : base
}
