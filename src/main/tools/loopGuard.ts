/**
 * Per-generation guard against a model calling the same tool with the same
 * arguments over and over in a row without making progress. Observed
 * directly: a local reasoning model called find_skill with an identical
 * query 672 times in a single turn, filling the entire context window until
 * node-llama-cpp's own context-shift recovery failed and force-ended the
 * turn with zero real work done.
 *
 * Only counts *consecutive* repeats of the same key, resetting the moment a
 * different call happens — legitimate agentic work (write, test, write,
 * test, ...) interleaves distinct calls between repeats of the same one and
 * must never trip this; four straight, truly identical repeats with nothing
 * in between is the actual failure mode this exists to catch.
 */
export interface LoopGuardState {
  lastKey: string | null
  lastKeyCount: number
}

export function createLoopGuardState(): LoopGuardState {
  return { lastKey: null, lastKeyCount: 0 }
}

/** Calls beyond this many consecutive identical repeats are blocked. */
export const LOOP_GUARD_LIMIT = 3

/**
 * If a model keeps repeating the exact same call even after being blocked
 * and told to stop, generation is force-aborted once the consecutive
 * attempt count reaches this many — rather than trusting the model to
 * eventually listen. Observed directly: blocking the call (see
 * `LOOP_GUARD_LIMIT`) stopped the wasted backend work, but the model kept
 * re-issuing the identical blocked call anyway — 205 times in a row — until
 * the context window itself ran out, which is the exact failure this guard
 * exists to prevent. A couple of ignored nudges are tolerated (a model may
 * need one retry to adjust course); this many in a row means it isn't
 * reacting to the message at all.
 */
export const LOOP_GUARD_ABORT_AFTER = LOOP_GUARD_LIMIT + 3

/**
 * Record an attempted call and report whether it should be blocked, and
 * whether generation should be force-aborted outright. Mutates `state` —
 * call once per attempted tool invocation, before running it. `key` should
 * identify the call as precisely as possible (see `loopGuardKey` below) —
 * a coarser key (e.g. just a UI title) will treat calls that are actually
 * different as repeats of each other.
 */
export function checkLoopGuard(
  state: LoopGuardState,
  name: string,
  key: string
): { blocked: boolean; shouldAbort: boolean; count: number } {
  const fullKey = `${name}::${key}`
  if (state.lastKey === fullKey) {
    state.lastKeyCount++
  } else {
    state.lastKey = fullKey
    state.lastKeyCount = 1
  }
  return {
    blocked: state.lastKeyCount > LOOP_GUARD_LIMIT,
    shouldAbort: state.lastKeyCount >= LOOP_GUARD_ABORT_AFTER,
    count: state.lastKeyCount
  }
}

/**
 * A stable, order-independent fingerprint of a tool call's real arguments.
 * Prefer passing `args` (the tool handler's own parsed arguments object) on
 * every spec — falling back to `title` when it's missing is only a safety
 * net for tools that haven't been updated yet, not something to rely on: a
 * UI title is written to be a short human-readable summary, not a complete
 * argument encoding, and several tools' titles are lossy or even constant
 * regardless of arguments (e.g. `write_file`'s title omits the new content
 * entirely, so four different edits to the same file would otherwise look
 * identical to this guard).
 */
export function loopGuardKey(spec: { args?: unknown; title: string }): string {
  return spec.args !== undefined ? stableStringify(spec.args) : spec.title
}

/** `JSON.stringify` with object keys sorted at every level, so key order never affects the result. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      )
    }
    return val
  })
}

/** The model-facing message returned instead of actually running a blocked call. */
export function loopGuardMessage(name: string, count: number, aborting: boolean): string {
  const base =
    `You've already called ${name} with identical arguments ${count} times in a row ` +
    'without new results — this looks like a loop, not progress. Stop repeating this exact ' +
    'call. Try different arguments, use a different tool, or explain to the user what is ' +
    'blocking you instead.'
  return aborting
    ? `${base} Generation is being stopped now because this kept repeating after being told to stop.`
    : base
}
