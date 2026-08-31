/**
 * Per-generation guard against a model calling the same tool with the same
 * arguments over and over in a row without making progress. Observed
 * directly: a local reasoning model called find_skill with an identical
 * query 672 times in a single turn, filling the entire context window until
 * node-llama-cpp's own context-shift recovery failed and force-ended the
 * turn with zero real work done.
 *
 * Counts both consecutive repeats and short exact cycles such as A-B-A-B.
 * Legitimate edit/test work remains safe because changed edit arguments
 * produce a different fingerprint; an exact recurring cycle means neither
 * action is changing and therefore no progress is being made.
 */
export interface LoopGuardState {
  lastKey: string | null
  lastKeyCount: number
  recentKeys: string[]
  recentStableReadKeys: string[]
  /** Recent query-bearing calls, for the paraphrase check — see `semanticRepeatCount`. */
  recentQueries: QueryObservation[]
}

/** One search-style call reduced to its meaningful terms. */
interface QueryObservation {
  tool: string
  tokens: string[]
}

/**
 * Forget the repeat history of re-readable calls, because the model no longer
 * has what they returned.
 *
 * Called when a context epoch resets the model's history. Measured on a 4B
 * model at an 8,192-token window: it read `test_stats.py` successfully, the
 * result was evicted within a turn or two, it asked again, and after six
 * identical asks `shouldAbort` refused that read for the rest of the run — 181
 * refusals, for a file sitting in the workspace.
 *
 * The guard cannot otherwise tell a model stuck in a loop from one that has
 * genuinely lost what it read; an epoch is precisely the event that separates
 * them. Only the counters are cleared: nothing about what the *task* has
 * established lives here, and re-reads remain bounded by the gathering ladder
 * and by `projectHistoryForModel` collapsing identical reads to the newest.
 */
export function forgetRepeatsAcrossEpoch(
  state: LoopGuardState,
  /**
   * Whether the most recent call was one that is safe to repeat. A write is
   * not: re-writing identical content is not made necessary by eviction, and
   * it is the shape that duplicated a block three times over in `patch_file`.
   * Only the consecutive counter needs this guard — the read-specific history
   * below is read-only by construction.
   */
  lastCallWasRereadable: boolean
): void {
  if (lastCallWasRereadable) {
    state.lastKey = null
    state.lastKeyCount = 0
  }
  state.recentKeys = []
  state.recentStableReadKeys = []
  state.recentQueries = []
}

export function createLoopGuardState(): LoopGuardState {
  return {
    lastKey: null,
    lastKeyCount: 0,
    recentKeys: [],
    recentStableReadKeys: [],
    recentQueries: []
  }
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
 *
 * `args` is optional and used only for the paraphrase check
 * ({@link semanticRepeatCount}), which catches the case exact fingerprinting
 * cannot: the same question asked five different ways.
 */
export function checkLoopGuard(
  state: LoopGuardState,
  name: string,
  key: string,
  args?: unknown
): { blocked: boolean; shouldAbort: boolean; count: number } {
  const fullKey = `${name}::${key}`
  state.recentKeys.push(fullKey)
  if (state.recentKeys.length > LOOP_GUARD_ABORT_AFTER * 3) state.recentKeys.shift()
  if (STABLE_READ_TOOLS.has(name)) {
    state.recentStableReadKeys.push(fullKey)
    if (state.recentStableReadKeys.length > LOOP_GUARD_ABORT_AFTER * 3) {
      state.recentStableReadKeys.shift()
    }
  } else {
    // A mutation, command, or external call can legitimately change what a
    // later read returns, so it starts a fresh stable-read observation window.
    state.recentStableReadKeys = []
  }
  if (state.lastKey === fullKey) {
    state.lastKeyCount++
  } else {
    state.lastKey = fullKey
    state.lastKeyCount = 1
  }
  const cycleCount = repeatingSuffixCount(state.recentKeys)
  const interleavedStableReadCount = STABLE_READ_TOOLS.has(name)
    ? state.recentStableReadKeys.filter((key) => key === fullKey).length
    : 1
  const exactCount = Math.max(state.lastKeyCount, cycleCount, interleavedStableReadCount)
  const paraphraseCount = semanticRepeatCount(state, name, args)

  return {
    blocked: Math.max(exactCount, paraphraseCount) > LOOP_GUARD_LIMIT,
    // Force-abort stays keyed to *exact* repetition only. A paraphrase loop
    // means the model is still composing new arguments, so blocking the call
    // and telling it why is enough; killing the generation outright on fuzzy
    // evidence would be too blunt and could cut off legitimate exploration.
    shouldAbort: exactCount >= LOOP_GUARD_ABORT_AFTER,
    count: Math.max(exactCount, paraphraseCount)
  }
}

/**
 * How many recent calls asked the same question as this one, ignoring wording.
 *
 * Exact-argument fingerprinting is defeated by trivial rephrasing. In the
 * driving incident the model ran five semantic searches for one symbol —
 * "updateClickRipples function definition", "…in universe-sandbox",
 * "…in universe sandbox", "function updateClickRipples definition" — and every
 * one produced a different fingerprint, so the guard never fired and five tool
 * calls bought nothing.
 *
 * Queries are reduced to their meaningful terms (stop words dropped, sorted,
 * deduplicated) and compared by *subset relation* rather than equality:
 * `{updateclickripples}` and `{updateclickripples, universe, sandbox}` are the
 * same question with more or less qualification, while
 * `{three, import, failure}` and `{three, render, scene}` are neither a subset
 * nor a superset of one another and stay distinct. Narrowing or widening a
 * search that is not returning the answer is the exact behavior worth stopping;
 * genuinely changing subject is not.
 *
 * Returns 1 for anything without a query, leaving the exact check in charge.
 */
function semanticRepeatCount(state: LoopGuardState, name: string, args: unknown): number {
  // Checked before the query test, not after: a mutation or command can
  // legitimately change what the same search returns, and most of them carry
  // no query argument at all — returning early on that would mean the window
  // was never actually cleared by the writes it exists to react to.
  if (!STABLE_READ_TOOLS.has(name)) state.recentQueries = []

  const tokens = queryTokens(args)
  if (tokens.length === 0) return 1

  const related = state.recentQueries.filter(
    (observation) => observation.tool === name && isSubsetOrSuperset(observation.tokens, tokens)
  )
  state.recentQueries.push({ tool: name, tokens })
  if (state.recentQueries.length > LOOP_GUARD_ABORT_AFTER * 3) state.recentQueries.shift()

  // +1 for the attempt being recorded now.
  return related.length + 1
}

/** Argument fields that carry a natural-language or pattern query. */
const QUERY_FIELDS = ['query', 'pattern', 'search', 'text', 'q']

/**
 * Terms that describe *how* something is being looked for rather than *what*,
 * so they carry no distinguishing signal between two searches.
 */
const QUERY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'of',
  'for',
  'in',
  'on',
  'to',
  'is',
  'are',
  'or',
  'where',
  'what',
  'does',
  'do',
  'find',
  'search',
  'look',
  'definition',
  'defined',
  'define',
  'function',
  'method',
  'variable',
  'const',
  'class',
  'file',
  'code'
])

/** Reduce a call's query argument to sorted, deduplicated, meaningful terms. */
function queryTokens(args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return []
  const record = args as Record<string, unknown>
  const field = QUERY_FIELDS.find((name) => typeof record[name] === 'string')
  if (!field) return []

  const raw = record[field] as string
  const tokens = raw
    // Split camelCase/PascalCase *before* lowercasing — afterwards there is no
    // case boundary left to split on.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !QUERY_STOP_WORDS.has(token))

  return [...new Set(tokens)].sort()
}

function isSubsetOrSuperset(left: string[], right: string[]): boolean {
  const [smaller, larger] = left.length <= right.length ? [left, right] : [right, left]
  if (smaller.length === 0) return false
  const largerSet = new Set(larger)
  return smaller.every((token) => largerSet.has(token))
}

/** Catch A-B-A-B and A-B-C cycles in addition to a single repeated call. */
function repeatingSuffixCount(keys: string[]): number {
  let best = 1
  for (let cycleLength = 1; cycleLength <= 3; cycleLength++) {
    if (keys.length < cycleLength * 2) continue
    const cycle = keys.slice(-cycleLength)
    let repeats = 1
    for (let end = keys.length - cycleLength; end >= cycleLength; end -= cycleLength) {
      const candidate = keys.slice(end - cycleLength, end)
      if (candidate.some((key, index) => key !== cycle[index])) break
      repeats++
    }
    best = Math.max(best, repeats)
  }
  return best
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
    `You've already called ${name} with identical effective arguments ${count} times this turn ` +
    'without new results — this looks like a loop, not progress. Stop repeating this exact ' +
    'call. Try different arguments, use a different tool, or explain to the user what is ' +
    'blocking you instead.'
  return aborting
    ? `${base} Generation is being stopped now because this kept repeating after being told to stop.`
    : base
}

/** Reads whose result cannot change until a non-read action occurs. */
const STABLE_READ_TOOLS = new Set([
  'list_directory',
  'read_file',
  'read_file_range',
  'read_multiple_files',
  'find_files',
  'search_files',
  'search_code',
  'code_outline'
])
