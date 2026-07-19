import { MAX_COMPACTION_SUMMARY_TOKENS, SUMMARY_CHUNK_TOKEN_BUDGET } from './compaction'

/**
 * Shared bounded rolling-compaction primitive.
 *
 * Both places Anodex condenses overflowing history into a summary — the
 * between-turn path (`assembleModelContext` in `contextAssembler.ts`, over
 * `ChatHistoryTurn`s) and the mid-turn context-shift strategy
 * (`contextShiftStrategy.ts`, over node-llama-cpp `ChatHistoryItem`s) — have
 * the same constraint: the summarizer itself runs in a small dedicated
 * context (4,096 tokens — `LlamaService.ensureSummarySequence`), so the
 * transcript must be fed to it in bounded chunks, never all at once. This
 * module owns that chunk-and-fold loop once, generically, so the two paths
 * can't drift into subtly different chunking systems.
 *
 * The fold is replacement-style: each summarizer call receives the previous
 * rolling summary plus one new chunk and returns the complete *updated*
 * summary (see `buildCompactionUpdatePrompt` in `compaction.ts`). The
 * summary is therefore bounded by the summarizer's own output cap
 * (`MAX_COMPACTION_SUMMARY_TOKENS`) no matter how many chunks are folded —
 * unlike concatenation, which grows without limit. When a chunk fails to
 * summarize (degenerate output, generation error), only that chunk degrades:
 * a hard-capped deterministic digest of it is appended instead, clamped so
 * even repeated failures can't blow the summary past
 * `ROLLING_SUMMARY_TOKEN_CEILING` — and every other chunk's LLM summary
 * survives.
 */

/**
 * Replacement-style summarizer: fold `transcript` into `previousSummary` and
 * return the complete updated summary, or `null` on failure (degenerate
 * output, generation error, no API key, ...). Implementations:
 * `LlamaService.summarizeHistoryForCompaction` (local),
 * `summarizeForCompactionAnthropic`/`summarizeForCompactionOpenAi` (cloud).
 */
export interface RollingSummarizer {
  (transcript: string, previousSummary?: string): Promise<string | null>
}

/**
 * Below this, a transcript chunk isn't worth a summarization round-trip —
 * it goes straight into the deterministic digest path instead. Mirrors
 * `MIN_CHARS_TO_SUMMARIZE` in `compaction.ts` but smaller: a trailing chunk
 * left over after budget-splitting is often shorter than a whole
 * conversation slice.
 */
export const MIN_CHUNK_CHARS_TO_SUMMARIZE = 120

/** Hard token cap on a single failed chunk's deterministic digest — a failed
 *  chunk must never copy arbitrarily large transcript text into the summary. */
export const FALLBACK_DIGEST_MAX_TOKENS = 400

/**
 * Ceiling on the whole rolling summary once deterministic digests are
 * appended to it. The LLM path is already bounded by
 * `MAX_COMPACTION_SUMMARY_TOKENS`; this allows one digest's worth of
 * overflow on top before further digest appends are dropped. Sized together
 * with the summarizer's 4,096-token context — see
 * `MAX_COMPACTION_SUMMARY_TOKENS`'s doc comment for the arithmetic.
 */
export const ROLLING_SUMMARY_TOKEN_CEILING =
  MAX_COMPACTION_SUMMARY_TOKENS + FALLBACK_DIGEST_MAX_TOKENS

/** Same separator `mergeContextSummaries` (contextAssembler.ts) already uses,
 *  so digests read consistently wherever summaries surface in the UI. */
const APPEND_SEPARATOR = '\n\nAdditional compacted context:\n'

const TRUNCATION_SUFFIX = '… (truncated)'

export interface FoldIntoRollingSummaryOptions<T> {
  /** Items to fold, oldest-first. All of them will be covered by the result. */
  items: readonly T[]
  /** Rolling summary from a previous fold, carried forward and updated. */
  previousSummary: string | undefined
  /** Full transcript rendering of a run of items, as the summarizer should see it. */
  renderTranscript: (items: readonly T[]) => string
  /**
   * Token cost of one item's *rendered transcript* — i.e. of what
   * `renderTranscript([item])` produces, which may legitimately be
   * preview-truncated. This budget governs only what is sent to the
   * summarizer; it is NOT a fit-check on what ships back into the model
   * context (callers own that separately, with full untruncated costs).
   */
  itemTranscriptCost: (item: T) => number
  countTokens: (text: string) => number
  summarize: RollingSummarizer
  /** Override for tests; defaults to `SUMMARY_CHUNK_TOKEN_BUDGET`. */
  chunkTokenBudget?: number
}

/**
 * Fold `items` (oldest-first) into a bounded rolling summary. Returns the
 * updated summary, or `previousSummary` unchanged when there is nothing to
 * fold, or `undefined` when there is no previous summary and nothing folded.
 */
export async function foldIntoRollingSummary<T>(
  options: FoldIntoRollingSummaryOptions<T>
): Promise<string | undefined> {
  const { items, renderTranscript, itemTranscriptCost, countTokens } = options
  const budget = options.chunkTokenBudget ?? SUMMARY_CHUNK_TOKEN_BUDGET
  // Clamp the incoming summary with the real token counter, not trust — a
  // caller can hand over a legacy oversized summary (e.g. a pre-rolling
  // epoch snapshot built by concatenation), and an unclamped one would blow
  // the summarizer's input budget on the very first fold.
  let running = clampSummary(options.previousSummary, countTokens)

  let i = 0
  while (i < items.length) {
    if (itemTranscriptCost(items[i]) > budget) {
      // A single item whose transcript alone exceeds the chunk budget (e.g.
      // one turn holding dozens of tool calls) — fold its rendered transcript
      // in budget-sized slices rather than sending one oversized chunk the
      // summarizer's context can't actually hold.
      const slices = sliceTextByTokenBudget(renderTranscript([items[i]]), budget, countTokens)
      for (const slice of slices) {
        running = await foldChunk(slice, running, options)
      }
      i++
      continue
    }

    const start = i
    i += 1
    while (i < items.length) {
      const itemCost = itemTranscriptCost(items[i])
      if (itemCost > budget) break // oversized item starts its own sliced fold next iteration
      // Token costs are not generally additive, and the full renderer can
      // add separators or role labels between otherwise-small items.
      if (countTokens(renderTranscript(items.slice(start, i + 1))) > budget) break
      i++
    }
    running = await foldChunk(renderTranscript(items.slice(start, i)), running, options)
  }

  return running
}

/**
 * Clamp a summary to `ROLLING_SUMMARY_TOKEN_CEILING`, measured with the real
 * token counter — the ceiling the fold's input arithmetic budgets for (see
 * `MAX_COMPACTION_SUMMARY_TOKENS`'s doc comment in `compaction.ts`: 4,096 ≥
 * output + framing + THIS ceiling + chunk + slack). Applied to both the
 * incoming previous summary (which may be a legacy oversized epoch snapshot
 * built by concatenation) and every LLM-returned summary (generation-side
 * `maxTokens` should already bound those, but the ceiling is enforced here,
 * where the next fold's arithmetic relies on it, not merely requested of the
 * backend).
 */
function clampSummary(
  summary: string | undefined,
  countTokens: (text: string) => number
): string | undefined {
  if (!summary?.trim()) return undefined
  return truncateToTokenBudget(summary, ROLLING_SUMMARY_TOKEN_CEILING, countTokens) || undefined
}

/** Fold one bounded transcript chunk: LLM replacement summary, or a capped deterministic digest on failure. */
async function foldChunk<T>(
  transcript: string,
  running: string | undefined,
  options: FoldIntoRollingSummaryOptions<T>
): Promise<string | undefined> {
  const trimmed = transcript.trim()
  if (!trimmed) return running

  if (trimmed.length >= MIN_CHUNK_CHARS_TO_SUMMARIZE) {
    try {
      const updated = await options.summarize(trimmed, running)
      // Clamp with the real token counter even though generation-side
      // `maxTokens` should already bound this — the ceiling here is what the
      // NEXT fold's input arithmetic depends on, so it's enforced where it's
      // relied upon, not merely requested of the backend.
      if (updated?.trim()) return clampSummary(updated, options.countTokens)
    } catch {
      // Summarizers contractually return null on failure, but a throw from a
      // cloud SDK edge case must degrade to the digest path, not abort the
      // whole fold and lose every other chunk's summary with it.
    }
  }

  const digest = truncateToTokenBudget(trimmed, FALLBACK_DIGEST_MAX_TOKENS, options.countTokens)
  return appendBounded(running, digest, options.countTokens)
}

/**
 * Append a deterministic digest to the rolling summary without letting the
 * total exceed `ROLLING_SUMMARY_TOKEN_CEILING`. The newest addition must
 * survive: callers advance durable coverage cursors after this fold returns,
 * so dropping it would permanently mark evidence as covered even though it
 * was never retained. Make room by shrinking the previous summary instead.
 */
function appendBounded(
  previous: string | undefined,
  addition: string,
  countTokens: (text: string) => number
): string | undefined {
  const trimmedAddition = addition.trim()
  if (!trimmedAddition) return previous
  if (!previous) {
    return truncateToTokenBudget(trimmedAddition, ROLLING_SUMMARY_TOKEN_CEILING, countTokens)
  }

  const boundedAddition = truncateToTokenBudget(
    trimmedAddition,
    Math.min(FALLBACK_DIGEST_MAX_TOKENS, ROLLING_SUMMARY_TOKEN_CEILING),
    countTokens
  )
  const separatorCost = countTokens(APPEND_SEPARATOR)
  const additionCost = countTokens(boundedAddition)
  if (separatorCost + additionCost >= ROLLING_SUMMARY_TOKEN_CEILING) {
    return truncateToTokenBudget(boundedAddition, ROLLING_SUMMARY_TOKEN_CEILING, countTokens)
  }

  const previousBudget = ROLLING_SUMMARY_TOKEN_CEILING - separatorCost - additionCost
  const boundedPrevious = truncateToTokenBudget(previous, previousBudget, countTokens)
  return truncateToTokenBudget(
    `${boundedPrevious}${APPEND_SEPARATOR}${boundedAddition}`,
    ROLLING_SUMMARY_TOKEN_CEILING,
    countTokens
  )
}

/**
 * Truncate `text` so it costs at most `budgetTokens`, measured with the real
 * `countTokens` (not a chars-per-token guess). Iterative proportional
 * shrinking: cheap, tokenizer-agnostic, and guaranteed to terminate since
 * every pass strictly shortens the text.
 */
export function truncateToTokenBudget(
  text: string,
  budgetTokens: number,
  countTokens: (text: string) => number
): string {
  if (budgetTokens <= 0) return ''
  let current = text
  const tokens = countTokens(current)
  if (tokens <= budgetTokens) return current

  const suffixTokens = countTokens(TRUNCATION_SUFFIX)
  if (suffixTokens > budgetTokens) {
    return shrinkPrefixToTokenBudget(text, budgetTokens, countTokens)
  }

  current = shrinkPrefixToTokenBudget(
    text,
    Math.max(0, budgetTokens - suffixTokens),
    countTokens
  ).trimEnd()
  let candidate = `${current}${TRUNCATION_SUFFIX}`
  while (countTokens(candidate) > budgetTokens && current.length > 0) {
    current = current.slice(0, -1).trimEnd()
    candidate = `${current}${TRUNCATION_SUFFIX}`
  }
  return countTokens(candidate) <= budgetTokens
    ? candidate
    : shrinkPrefixToTokenBudget(TRUNCATION_SUFFIX, budgetTokens, countTokens)
}

function shrinkPrefixToTokenBudget(
  text: string,
  budgetTokens: number,
  countTokens: (text: string) => number
): string {
  if (budgetTokens <= 0) return ''
  let current = text
  let tokens = countTokens(current)
  while (tokens > budgetTokens && current.length > 0) {
    const shrunk = Math.min(
      current.length - 1,
      Math.floor(current.length * (budgetTokens / tokens) * 0.95)
    )
    current = current.slice(0, Math.max(0, shrunk))
    tokens = countTokens(current)
  }
  return current
}

/**
 * Split `text` into consecutive slices each costing at most `budgetTokens`.
 * Used for a single item whose transcript alone exceeds the chunk budget.
 */
export function sliceTextByTokenBudget(
  text: string,
  budgetTokens: number,
  countTokens: (text: string) => number
): string[] {
  if (budgetTokens <= 0 || text.length === 0) return text.length === 0 ? [] : [text]

  const slices: string[] = []
  let rest = text
  while (rest.length > 0) {
    if (countTokens(rest) <= budgetTokens) {
      slices.push(rest)
      break
    }
    let take = rest
    let tokens = countTokens(take)
    while (tokens > budgetTokens && take.length > 1) {
      take = take.slice(
        0,
        Math.max(
          1,
          Math.min(take.length - 1, Math.floor(take.length * (budgetTokens / tokens) * 0.95))
        )
      )
      tokens = countTokens(take)
    }
    slices.push(take)
    rest = rest.slice(take.length)
  }
  return slices
}
