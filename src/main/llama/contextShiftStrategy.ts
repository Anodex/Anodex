import type {
  ChatHistoryItem,
  ChatModelResponse,
  ChatModelFunctionCall,
  ChatSystemMessage
} from 'node-llama-cpp'
import { reservedNonHistoryTokens } from './compaction'
import { foldIntoRollingSummary, type RollingSummarizer } from './rollingSummary'

/**
 * Custom `contextShift.strategy` for `LlamaChatSession`, replacing
 * node-llama-cpp's built-in `eraseFirstResponseAndKeepFirstSystemChatContext
 * ShiftStrategy` — the strategy that throws
 * `NODE_LLAMA_CPP_CONTEXT_TOO_LONG_CRASH_FRAGMENT` (see `compaction.ts`) when
 * a turn's own system prompt plus latest exchange can't be shrunk any
 * further by character-level truncation alone.
 *
 * Two distinct shapes of growth have to be handled, because node-llama-cpp
 * only ever appends a NEW `{type: 'model', response: [...]}` item when the
 * previous history item isn't already one — every function call within an
 * ongoing turn (see `addFunctionCallToChatHistory` in node-llama-cpp's
 * `LlamaChatSession.js`) is pushed into the *same* last model item's
 * `response` array, never a new item. Verified directly against a real
 * failed Critical Thinking run (38 tool calls, 69 sources): its node-llama-cpp
 * chat history was exactly `[system, user, model]` — three items, with all
 * 38 activities packed into that one model item's `response` array. A
 * strategy that only ever drops/summarizes whole *older* history items (the
 * only thing node-llama-cpp's own default strategy does) has nothing to work
 * with there — the single oversized item *is* the "first" and "last"
 * response at once.
 *
 * So this strategy operates at two levels:
 *  - Level 1 (normal multi-turn chat): whole older (user, model) exchanges,
 *    strictly before the final exchange, get folded into a bounded rolling
 *    summary via `foldIntoRollingSummary` (`rollingSummary.ts`) — the same
 *    primitive the between-turn compaction path uses. The summary plus a
 *    coverage cursor are carried across invocations via the strategy's
 *    `metadata`, so a later shift folds only the exchanges added *since* the
 *    last one instead of re-summarizing the same span from scratch every
 *    time (node-llama-cpp always hands the strategy the full uncompressed
 *    canonical history — verified in `LlamaChat.js`'s `getContextWindow`).
 *  - Level 2 (a single oversized turn, e.g. Critical Thinking): if the final
 *    exchange alone still doesn't fit after level 1, the oldest function
 *    calls *within* its model item's `response` array first get their
 *    results folded into the same rolling summary (so the eventual report
 *    can still draw on what trimmed sources said), then have their `result`
 *    replaced with a short marker — deliberately keeping `name` and `params`
 *    (a `fetch_url`/`web_search` call's `params` holds the exact URL/query),
 *    since losing which sources were already checked is worse than losing
 *    their full text. An `evidence` cursor in the metadata prevents
 *    re-folding the same calls on the next shift of the same turn.
 *
 * Budget/fit decisions use FULL costs (`fullItemCost`: complete results,
 * params, rawCall) — what actually ships back into the context — while
 * summarizer chunking uses preview-based transcript costs (what the
 * summarizer actually receives). Conflating the two (as an earlier draft
 * did) undercounts large tool results and returns history that node-llama-
 * cpp's own re-verification rejects, falling back to the crashing default
 * strategy on exactly the pathological case this exists to fix.
 *
 * node-llama-cpp re-verifies whatever this returns against the real
 * tokenizer/chat-wrapper/function-schema budget itself (see
 * `compressHistoryToFitContextSize` in `LlamaChat.js`) and silently falls
 * back to its own default strategy if this throws or under/over-shoots — so
 * an imperfect estimate here degrades no worse than today, it just forgoes
 * this strategy's benefit for that one shift.
 */

/** Carried across successive strategy invocations via node-llama-cpp's `lastShiftMetadata`. */
export interface BoundedContextShiftMetadata {
  /** Rolling summary of everything shifted out of context so far, this session. */
  summary?: string
  /**
   * Number of non-system canonical history items (oldest-first) already
   * folded into `summary`. Later shifts fold only items past this cursor —
   * without it, every shift would re-summarize the same span from scratch
   * and append the redundant result, growing the summary without bound.
   */
  coveredItemCount?: number
  /**
   * Level-2 cursor: function calls `[0, callCount)` of the non-system item
   * at `itemIndex` have already had their results folded into `summary`
   * (they were trimmed to markers mid-turn). Prevents re-folding on the next
   * shift of the same turn; once the item ages behind `coveredItemCount`,
   * the cursor is dropped and level-1 folding of that item renders the
   * already-folded calls without their results.
   */
  evidence?: { itemIndex: number; callCount: number }
}

export interface BoundedContextShiftDeps {
  /**
   * Replacement-style rolling summarizer (see `RollingSummarizer` in
   * `rollingSummary.ts`) — receives one bounded transcript chunk plus the
   * previous rolling summary, and returns the complete updated summary, or
   * `null` on failure (the fold then degrades that one chunk to a bounded
   * deterministic digest instead of losing it outright). Backed by
   * `LlamaService.summarizeHistoryForCompaction`, which runs on its own
   * dedicated 4,096-token context, never the conversation's.
   */
  summarize: RollingSummarizer
  /** Convert a system message's `text` (plain string or LlamaTextJSON) to plain string. */
  stringifySystemText: (text: unknown) => string
  /**
   * Measured token cost of this generation's registered tool schemas
   * (`documentFunctionParams: true` in `LlamaService.generate()`), which
   * `chatHistory` never carries and the rendered-cost refinement loop's
   * `chatWrapper.generateContextState` call can't see either (it's called
   * without `availableFunctions` — see that loop's doc comment). Without
   * this, the strategy can measure its candidate as fitting when it
   * genuinely doesn't once node-llama-cpp adds real schema documentation
   * during its own re-verification — reproduced live: a project chat with a
   * full tool surface at a 4,096-token context measured as fitting
   * (`trimmedNewestExchange: false`, nothing trimmed) and was still rejected.
   * `0`/omitted for a tool-less generation.
   */
  toolSchemaReserveTokens?: number
  /**
   * Dynamic form used by a reused `LlamaChatSession`: enabled/MCP tools can
   * change between generations in the same conversation, so a strategy
   * closure must read the current reserve rather than retain the value from
   * the turn that created the session. Takes precedence over the static test
   * convenience field above.
   */
  getToolSchemaReserveTokens?: () => number
  /**
   * Observability hook, fired once per completed shift with what the shift
   * actually did. Purely informational — never affects the returned history.
   * Mid-turn shifts are otherwise invisible: unlike the between-turn
   * compaction path, there's no `historyCompacted` event here (this runs
   * inside node-llama-cpp's generation loop over its own in-flight history,
   * which doesn't map onto persisted-turn ids the renderer's compaction
   * marker needs), so without this hook a shift leaves no trace anywhere —
   * not even a log line — making stress-testing and production debugging
   * blind. Errors thrown by the hook are swallowed: a logging bug must not
   * turn into a strategy failure that silently reverts node-llama-cpp to its
   * crashing default strategy.
   */
  onShift?: (info: {
    /** Whole older exchanges folded into the rolling summary this shift (level 1). */
    foldedItemCount: number
    /** Function-call results folded then trimmed within the newest exchange this shift (level 2). */
    foldedEvidenceCallCount: number
    /** Whether the newest exchange still needed a deterministic trim to fit. */
    trimmedNewestExchange: boolean
    /** Whether the user's current message itself was shortened as an absolute last resort. */
    trimmedUserMessage: boolean
    /** Whether generated assistant text/thoughts or function-call content was shortened/dropped. */
    trimmedAssistantResponse: boolean
    /** Token cost of the rolling summary after this shift (0 when none). */
    summaryTokens: number
  }) => void
}

/**
 * Headroom below `maxTokensCount` this strategy targets, rather than the
 * full amount — node-llama-cpp's own re-verification tokenizes the
 * chat-wrapper's *rendered* form (role markers, function-call syntax,
 * template framing), which this module's plain-text estimates can't see
 * (`chatHistory` doesn't carry the wrapper's own rendering syntax).
 *
 * Two components, stacked:
 *  - `reservedNonHistoryTokens` — the SAME reservation the between-turn
 *    compaction path (`historyBudgetTokens` in `contextAssembler.ts`)
 *    already uses, covering wrapper syntax/framing in general. A fraction
 *    of `maxTokensCount`, not a flat amount — but even this alone is the
 *    wrong shape for the second component below (tool-schema cost is
 *    roughly constant per registered tool, not proportional to context
 *    size), which is why this function no longer stops here.
 *  - `toolSchemaReserveTokens` — the MEASURED cost of this generation's
 *    actual registered tool schemas (see `BoundedContextShiftDeps`'s doc
 *    comment). Reproduced live: a project chat (workspace tools + memory
 *    context) at a 4,096-token context hit `context-limit` on its very
 *    first message with `reservedNonHistoryTokens` alone still applied —
 *    the strategy measured its candidate as fitting (nothing in
 *    `chatHistory` needed trimming) and node-llama-cpp's own
 *    re-verification, WITH the real schemas added in, still rejected it.
 *    Measuring the actual schema cost and reserving for it directly closes
 *    that gap instead of hoping a generic reservation happens to cover it.
 */
function targetBudgetTokens(maxTokensCount: number, toolSchemaReserveTokens: number): number {
  return Math.max(
    0,
    maxTokensCount - reservedNonHistoryTokens(maxTokensCount) - toolSchemaReserveTokens
  )
}

/** Compact replacement for a trimmed function call's `result` — keeps `name`/`params` (e.g. a URL/query) intact. */
const TRIMMED_RESULT_MARKER =
  '(result trimmed to fit context — re-run this call if the exact detail is needed)'

/** Marker for a call whose result was folded into the rolling summary before an older item was itself summarized. */
const ALREADY_SUMMARIZED_MARKER = '(result already folded into the summary above)'

/**
 * Truncation length for a tool call's result text when rendered into a
 * summarizer transcript — keeps one large tool result from dominating the
 * chunk. Transcript-only: fit/trim decisions never use this preview.
 */
const TOOL_RESULT_PREVIEW_CHARS = 300

/** Keep-length for an oversized string value inside a compacted `params`. */
const PARAM_STRING_KEEP_CHARS = 200

/** Keep-length for oversized plain response strings / thought segments in the last-resort trim pass. */
const RESPONSE_TEXT_KEEP_CHARS = 200

/** Identifying fields remain exact during param compaction. If one of these
 * fields is itself irreducibly huge, the final call-drop pass can still omit
 * the whole call after its evidence has been folded into the summary. */
const IDENTIFYING_PARAM_KEYS = new Set([
  'id',
  'name',
  'path',
  'query',
  'url',
  'uri',
  'command',
  'source',
  'title'
])

function isFunctionCall(
  item: ChatModelResponse['response'][number]
): item is ChatModelFunctionCall {
  return typeof item !== 'string' && item.type === 'functionCall'
}

function isSegment(
  item: ChatModelResponse['response'][number]
): item is Extract<ChatModelResponse['response'][number], { type: 'segment' }> {
  return typeof item !== 'string' && item.type === 'segment'
}

/** Type guard, not just a `.type === 'system'` check inline — `chatHistory[0]?.type === 'system'`
 * alone doesn't narrow `chatHistory[0]` itself through a later ternary (TS2339: `ChatModelResponse`
 * has no `text` field), so callers need this to actually get a `ChatSystemMessage`-typed value back. */
function isSystemItem(item: ChatHistoryItem | undefined): item is ChatSystemMessage {
  return item?.type === 'system'
}

/** A function call's result as text — results are typically strings, but tolerate structured values. */
function functionCallResultText(call: ChatModelFunctionCall): string {
  if (call.result == null) return ''
  if (typeof call.result === 'string') return call.result
  try {
    return JSON.stringify(call.result)
  } catch {
    return String(call.result)
  }
}

/** A function call's params as text, for cost accounting and previews. */
function functionCallParamsText(call: ChatModelFunctionCall): string {
  if (call.params == null) return ''
  if (typeof call.params === 'string') return call.params
  try {
    return JSON.stringify(call.params)
  } catch {
    return String(call.params)
  }
}

/** Plain-text PREVIEW of one function call, for summarizer transcripts and deterministic digests only. */
function renderFunctionCall(call: ChatModelFunctionCall): string {
  const params = functionCallParamsText(call)
  const result = functionCallResultText(call)
  const preview =
    result.length > TOOL_RESULT_PREVIEW_CHARS
      ? `${result.slice(0, TOOL_RESULT_PREVIEW_CHARS)}…`
      : result
  return `[called ${call.name}(${params}) → ${preview}]`
}

/** Plain-text rendering of one chat history item, for feeding to the summarizer. */
function renderItem(item: ChatHistoryItem, stringifySystemText: (text: unknown) => string): string {
  if (item.type === 'system') return `System: ${stringifySystemText(item.text)}`
  if (item.type === 'user') return `User: ${item.text}`
  const parts: string[] = []
  for (const part of item.response) {
    if (typeof part === 'string') parts.push(part)
    else if (isFunctionCall(part)) parts.push(renderFunctionCall(part))
    else if (isSegment(part)) parts.push(part.text)
  }
  return `Assistant: ${parts.join(' ')}`.trim()
}

export function renderChatHistoryItemsForSummary(
  items: readonly ChatHistoryItem[],
  stringifySystemText: (text: unknown) => string
): string {
  return items
    .map((item) => renderItem(item, stringifySystemText))
    .filter(Boolean)
    .join('\n')
}

/**
 * FULL token cost of one function call as it ships back into the context:
 * complete result, complete params, and `rawCall` when present. Counting
 * `rawCall` on top of `params` double-counts slightly (the chat wrapper
 * renders one or the other), which is deliberately conservative — this
 * module must overshoot-safe its estimates, since node-llama-cpp rejects
 * returned history that doesn't actually fit.
 */
function fullFunctionCallCost(
  call: ChatModelFunctionCall,
  countTokens: (text: string) => number
): number {
  let cost = countTokens(call.name) + countTokens(functionCallParamsText(call))
  cost += countTokens(functionCallResultText(call))
  if (call.rawCall != null) {
    try {
      cost += countTokens(JSON.stringify(call.rawCall))
    } catch {
      // Uncountable rawCall — already conservatively covered by params above.
    }
  }
  return cost
}

/**
 * FULL token cost of one chat history item — what fit/trim decisions must
 * use. Distinct from the preview-based transcript cost used for summarizer
 * chunking (see the module doc comment for why conflating them is a bug).
 */
export function fullItemCost(item: ChatHistoryItem, countTokens: (text: string) => number): number {
  if (item.type === 'system') {
    return countTokens(typeof item.text === 'string' ? item.text : JSON.stringify(item.text))
  }
  if (item.type === 'user') return countTokens(item.text)
  let total = 0
  for (const part of item.response) {
    if (typeof part === 'string') total += countTokens(part)
    else if (isFunctionCall(part)) total += fullFunctionCallCost(part, countTokens)
    else if (isSegment(part)) total += countTokens(part.text)
  }
  return total
}

/**
 * Index (into `items`, which excludes any leading system item) where the
 * final exchange begins — the most recent `user` item, or 0 if none is
 * found (e.g. a session seeded straight into a model item). Everything
 * before this index is a whole older exchange eligible for level-1
 * summarization; everything from this index on is kept and, if still
 * oversized, handled by level-2 trimming instead.
 */
export function findLastExchangeStartIndex(items: readonly ChatHistoryItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].type === 'user') return i
  }
  return 0
}

/**
 * Level-2 trim: shrink the newest exchange (possibly one model item packed
 * with dozens of calls) until it fits `maxTokensCount`, measured by FULL
 * costs. Three passes, mildest first:
 *  1. Oldest function-call `result`s → `TRIMMED_RESULT_MARKER`, keeping
 *     `name`/`params`/`rawCall` — the exact URL/query survives.
 *  2. Oversized string values *inside* `params` → shortened with an
 *     "omitted" marker, clearing `rawCall` on any rewritten call — the chat
 *     wrapper renders a call from `rawCall` verbatim when present (verified
 *     in node-llama-cpp's `ChatWrapper.js`), so compacted params without
 *     clearing it would be a no-op. This is what finally shrinks a
 *     `write_file`-shaped call whose bulk is the file content in `params`.
 *  3. Long plain response strings and thought segments → truncated (segment
 *     `raw` dropped alongside its text).
 *  4. The oldest function calls dropped outright (replaced by a single
 *     omission notice). Needed because passes 1–3 have a floor — every call keeps
 *     name+params+marker — and a small context with dozens of calls can't
 *     fit even that floor once real chat-wrapper syntax is added per call
 *     (caught by the `contextShiftWrapperFit` test: Qwen's verbose function
 *     rendering at an 8K context). The dropped calls' findings were already
 *     folded into the rolling summary by level 2, so this loses live-context
 *     identity of old calls, not their evidence.
 *  5. Absolute last resort: the newest exchange's own `user` message text
 *     shrunk. Passes 1–4 only ever touch `model` items — a turn with a large
 *     pasted user message and no prior tool calls at all (verified live: a
 *     fresh project chat's very first message, nothing in history to fold,
 *     nothing in the model item yet to trim) was otherwise untouchable,
 *     guaranteeing this function returned its input byte-identical and
 *     node-llama-cpp rejected it outright.
 */
export function trimNewestExchangeToFit(
  items: readonly ChatHistoryItem[],
  maxTokensCount: number,
  countTokens: (text: string) => number
): ChatHistoryItem[] {
  const result = items.map((item) =>
    item.type === 'model' ? { ...item, response: [...item.response] } : item
  )
  const totalCost = (): number =>
    result.reduce((sum, item) => sum + fullItemCost(item, countTokens), 0)
  if (totalCost() <= maxTokensCount) return result

  const markerCost = countTokens(TRIMMED_RESULT_MARKER)

  // Pass 1: result markers, oldest call first.
  for (const item of result) {
    if (item.type !== 'model') continue
    for (let i = 0; i < item.response.length && totalCost() > maxTokensCount; i++) {
      const part = item.response[i]
      if (!isFunctionCall(part)) continue
      if (part.result === TRIMMED_RESULT_MARKER) continue
      if (countTokens(functionCallResultText(part)) <= markerCost) continue
      item.response[i] = { ...part, result: TRIMMED_RESULT_MARKER }
    }
  }
  if (totalCost() <= maxTokensCount) return result

  // Pass 2: compact oversized params, clearing stale rawCall.
  for (const item of result) {
    if (item.type !== 'model') continue
    for (let i = 0; i < item.response.length && totalCost() > maxTokensCount; i++) {
      const part = item.response[i]
      if (!isFunctionCall(part)) continue
      const compacted = compactFunctionCallParams(part)
      if (compacted) item.response[i] = compacted
    }
  }
  if (totalCost() <= maxTokensCount) return result

  // Pass 3: truncate long plain strings and thought segments.
  for (const item of result) {
    if (item.type !== 'model') continue
    for (let i = 0; i < item.response.length && totalCost() > maxTokensCount; i++) {
      const part = item.response[i]
      if (typeof part === 'string') {
        if (part.length < RESPONSE_TEXT_KEEP_CHARS) continue
        item.response[i] = `${part.slice(0, RESPONSE_TEXT_KEEP_CHARS)}…`
      } else if (isSegment(part)) {
        if (part.text.length < RESPONSE_TEXT_KEEP_CHARS) continue
        item.response[i] = {
          ...part,
          text: `${part.text.slice(0, RESPONSE_TEXT_KEEP_CHARS)}…`,
          raw: undefined
        }
      }
    }
  }
  if (totalCost() <= maxTokensCount) return result

  // Pass 4: drop the oldest calls outright (see the doc comment above).
  for (const item of result) {
    if (item.type !== 'model') continue
    let dropped = 0
    let dropPosition = -1
    while (totalCost() > maxTokensCount) {
      const oldestIndex = item.response.findIndex(isFunctionCall)
      if (oldestIndex < 0) break
      item.response.splice(oldestIndex, 1)
      if (dropPosition < 0) dropPosition = oldestIndex
      dropped += 1
    }
    if (dropped > 0) {
      item.response.splice(
        Math.max(0, dropPosition),
        0,
        `(${dropped} earlier tool call${dropped === 1 ? '' : 's'} omitted to fit context — their findings are folded into the summary above)`
      )
    }
  }
  if (totalCost() <= maxTokensCount) return result

  // Pass 5: absolute last resort — shrink the newest exchange's own `user`
  // message text. Passes 1-4 only ever touch `model` items (function-call
  // results, params, plain response strings); a large pasted user message
  // with NO prior tool calls at all (verified live: a fresh project chat's
  // very first turn, no history to fold, nothing in the model item yet to
  // trim) was previously untouchable here, guaranteeing this function
  // returned its input unchanged and node-llama-cpp rejected it outright.
  // Reordering wouldn't help — this loses the user's own words, which
  // matters more than an old tool result, so it only runs once everything
  // else has already failed to make room.
  const noticeCost = countTokens(USER_TEXT_TRUNCATION_NOTICE)
  for (let i = 0; i < result.length && totalCost() > maxTokensCount; i++) {
    const item = result[i]
    if (item.type !== 'user') continue
    const budgetForItem = Math.max(0, maxTokensCount - (totalCost() - countTokens(item.text)))
    if (countTokens(item.text) <= budgetForItem) continue
    const keep = Math.max(0, budgetForItem - noticeCost)
    result[i] = {
      ...item,
      text: `${truncateTextToTokens(item.text, keep, countTokens)}${USER_TEXT_TRUNCATION_NOTICE}`
    }
  }
  return result
}

/** Notice appended when pass 5 has to shrink the user's own message text. */
const USER_TEXT_TRUNCATION_NOTICE = ' [message truncated to fit context]'

/** Iterative proportional shrink to a token budget — same approach as `rollingSummary.ts`'s `truncateToTokenBudget`, kept local to avoid a cross-module dependency for one call site. */
function truncateTextToTokens(
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
 * Replace oversized string values inside a call's `params` with a short
 * excerpt plus an "omitted" marker, keeping small identifying fields (URLs,
 * paths, queries are typically well under the threshold) untouched. Returns
 * `null` when nothing needed compacting. Any rewrite clears `rawCall` — see
 * `trimNewestExchangeToFit`'s doc for why keeping it would undo the rewrite.
 */
function compactFunctionCallParams(call: ChatModelFunctionCall): ChatModelFunctionCall | null {
  const threshold = PARAM_STRING_KEEP_CHARS * 2

  if (typeof call.params === 'string') {
    if (call.params.length <= threshold) return null
    return {
      ...call,
      params: `${call.params.slice(0, PARAM_STRING_KEEP_CHARS)}… (content omitted: ${call.params.length} chars total)`,
      rawCall: undefined
    }
  }
  if (call.params == null || typeof call.params !== 'object') {
    return null
  }

  const compacted = compactParamValue(call.params, undefined, threshold, new WeakSet<object>())
  if (!compacted.changed) return null
  return { ...call, params: compacted.value, rawCall: undefined }
}

function compactParamValue(
  value: unknown,
  key: string | undefined,
  threshold: number,
  seen: WeakSet<object>
): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    if (value.length <= threshold || (key && IDENTIFYING_PARAM_KEYS.has(key.toLowerCase()))) {
      return { value, changed: false }
    }
    return {
      value: `${value.slice(0, PARAM_STRING_KEEP_CHARS)}… (content omitted: ${value.length} chars total)`,
      changed: true
    }
  }
  if (value == null || typeof value !== 'object' || seen.has(value)) {
    return { value, changed: false }
  }

  seen.add(value)
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((entry) => {
      const compacted = compactParamValue(entry, key, threshold, seen)
      changed ||= compacted.changed
      return compacted.value
    })
    return { value: changed ? next : value, changed }
  }

  let changed = false
  const next: Record<string, unknown> = {}
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    const compacted = compactParamValue(entryValue, entryKey, threshold, seen)
    changed ||= compacted.changed
    next[entryKey] = compacted.value
  }
  return { value: changed ? next : value, changed }
}

function buildSystemItemWithSummary(
  originalSystemText: string | undefined,
  summary: string | undefined
): ChatSystemMessage {
  const text = summary
    ? [originalSystemText, '---', 'Summary of earlier compacted context:', summary]
        .filter(Boolean)
        .join('\n')
    : (originalSystemText ?? '')
  return { type: 'system', text }
}

function shrinkSummaryForRenderedFit(
  originalSystemText: string | undefined,
  summary: string | undefined,
  chatWrapper: ChatWrapperLike | undefined,
  tokenizer: unknown,
  countTokens: (text: string) => number,
  targetBudget: number,
  exchange: readonly ChatHistoryItem[]
): { systemItem: ChatSystemMessage; summary: string | undefined } {
  if (!chatWrapper || !summary) {
    return { systemItem: buildSystemItemWithSummary(originalSystemText, summary), summary }
  }

  const fits = (candidateSummary: string | undefined): boolean => {
    const candidateSystem = buildSystemItemWithSummary(originalSystemText, candidateSummary)
    const rendered = renderedTokenCost([candidateSystem, ...exchange], chatWrapper, tokenizer)
    return rendered == null || rendered <= targetBudget
  }

  if (fits(summary))
    return { systemItem: buildSystemItemWithSummary(originalSystemText, summary), summary }

  let low = 0
  let high = countTokens(summary)
  let best: string | undefined

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = mid > 0 ? truncateTextToTokens(summary, mid, countTokens) : undefined
    if (fits(candidate)) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return { systemItem: buildSystemItemWithSummary(originalSystemText, best), summary: best }
}

/**
 * Parse `lastShiftMetadata` defensively: it may be ours from a previous
 * shift, `null` on the first shift, or a *foreign* shape — when this
 * strategy overshoots and node-llama-cpp falls back to its default strategy
 * for one shift, the next call receives the default's
 * `{removedCharactersNumber}` metadata. Field-by-field validation makes a
 * foreign shape degrade to "no prior state" instead of being misread.
 */
function readMetadata(value: unknown): {
  summary?: string
  coveredItemCount: number
  evidence?: { itemIndex: number; callCount: number }
} {
  if (value == null || typeof value !== 'object') return { coveredItemCount: 0 }
  const meta = value as Partial<BoundedContextShiftMetadata>

  const summary = typeof meta.summary === 'string' && meta.summary.trim() ? meta.summary : undefined
  // A coverage cursor without its summary would silently lose the covered
  // items' content — treat that (never produced by this module) as no state.
  const coveredItemCount =
    summary != null &&
    typeof meta.coveredItemCount === 'number' &&
    Number.isFinite(meta.coveredItemCount)
      ? Math.max(0, Math.floor(meta.coveredItemCount))
      : 0
  const evidence =
    summary != null &&
    meta.evidence != null &&
    typeof meta.evidence === 'object' &&
    typeof meta.evidence.itemIndex === 'number' &&
    Number.isInteger(meta.evidence.itemIndex) &&
    meta.evidence.itemIndex >= 0 &&
    typeof meta.evidence.callCount === 'number' &&
    Number.isInteger(meta.evidence.callCount) &&
    meta.evidence.callCount >= 0
      ? { itemIndex: meta.evidence.itemIndex, callCount: meta.evidence.callCount }
      : undefined

  return { summary, coveredItemCount, evidence }
}

function findEvidenceTarget(items: readonly ChatHistoryItem[]): {
  localItemIndex: number
  functionCalls: ChatModelFunctionCall[]
} | null {
  for (let localItemIndex = 0; localItemIndex < items.length; localItemIndex++) {
    const item = items[localItemIndex]
    if (item.type !== 'model') continue
    const functionCalls = item.response.filter(isFunctionCall)
    if (functionCalls.length > 0) return { localItemIndex, functionCalls }
  }
  return null
}

/**
 * Return the exclusive ordinal of the last original function call that the
 * fitted exchange changed or dropped. Trimming is oldest-first, so folding
 * this prefix before accepting the fitted history preserves every affected
 * call even when summary growth or wrapper overhead forces a deeper trim than
 * the first estimate predicted.
 */
function affectedFunctionCallPrefixEnd(
  originalCalls: readonly ChatModelFunctionCall[],
  fittedItem: ChatHistoryItem | undefined
): number {
  if (fittedItem?.type !== 'model') return originalCalls.length
  const survivingOriginalCalls = new Set(fittedItem.response.filter(isFunctionCall))
  let end = 0
  for (let i = 0; i < originalCalls.length; i++) {
    if (!survivingOriginalCalls.has(originalCalls[i])) end = i + 1
  }
  return end
}

function newestExchangeTrimDetails(
  original: readonly ChatHistoryItem[],
  fitted: readonly ChatHistoryItem[]
): { trimmedUserMessage: boolean; trimmedAssistantResponse: boolean } {
  let trimmedUserMessage = original.length !== fitted.length
  let trimmedAssistantResponse = original.length !== fitted.length

  for (let i = 0; i < original.length; i++) {
    const before = original[i]
    const after = fitted[i]
    if (before.type === 'user') {
      if (after?.type !== 'user' || after.text !== before.text) trimmedUserMessage = true
      continue
    }
    if (before.type !== 'model') continue
    if (after?.type !== 'model' || after.response.length !== before.response.length) {
      trimmedAssistantResponse = true
      continue
    }
    if (before.response.some((part, index) => part !== after.response[index])) {
      trimmedAssistantResponse = true
    }
  }
  return { trimmedUserMessage, trimmedAssistantResponse }
}

/**
 * The slice of node-llama-cpp's `ChatWrapper` this strategy actually uses —
 * a structural type rather than the class itself so tests can pass a real
 * wrapper (or nothing) without constructing native-adjacent machinery, and
 * so the strategy module stays import-light (type-only coupling).
 */
export interface ChatWrapperLike {
  generateContextState(options: { chatHistory: readonly ChatHistoryItem[] }): {
    contextText: { tokenize(tokenizer: unknown): unknown[] }
  }
}

/**
 * Real rendered token cost of `history` through the same wrapper+tokenizer
 * node-llama-cpp's own fit-check uses, or `null` when it can't be measured
 * (wrapper quirk, odd history shape) — a failed measurement must degrade to
 * "skip the refinement", never fail the whole shift.
 */
function renderedTokenCost(
  history: readonly ChatHistoryItem[],
  chatWrapper: ChatWrapperLike,
  tokenizer: unknown
): number | null {
  try {
    const { contextText } = chatWrapper.generateContextState({ chatHistory: history })
    return contextText.tokenize(tokenizer).length
  } catch {
    return null
  }
}

/**
 * Build the actual `contextShift.strategy` callback passed to
 * `new LlamaChatSession({ contextShift: { strategy } })`. See the module doc
 * comment for the two-level algorithm.
 */
export function createBoundedContextShiftStrategy(deps: BoundedContextShiftDeps) {
  return async function boundedContextShiftStrategy(options: {
    chatHistory: readonly ChatHistoryItem[]
    maxTokensCount: number
    tokenizer: (text: string) => unknown[]
    /**
     * The real chat wrapper node-llama-cpp always passes alongside the
     * tokenizer. Optional here so unit tests exercising only the plain-cost
     * logic can omit it — without it the rendered-cost refinement below is
     * skipped, never failed.
     */
    chatWrapper?: ChatWrapperLike
    lastShiftMetadata?: object | null
  }): Promise<{ chatHistory: ChatHistoryItem[]; metadata: BoundedContextShiftMetadata }> {
    const { chatHistory, maxTokensCount, tokenizer, chatWrapper, lastShiftMetadata } = options
    const countTokens = (text: string): number => tokenizer(text).length
    const toolSchemaReserveTokens =
      deps.getToolSchemaReserveTokens?.() ?? deps.toolSchemaReserveTokens ?? 0
    const targetBudget = targetBudgetTokens(maxTokensCount, toolSchemaReserveTokens)

    const systemItem = isSystemItem(chatHistory[0]) ? chatHistory[0] : null
    const originalSystemText = systemItem ? deps.stringifySystemText(systemItem.text) : undefined
    const rest = systemItem ? chatHistory.slice(1) : chatHistory.slice()

    const exchangeStart = findLastExchangeStartIndex(rest)
    const newestExchange = rest.slice(exchangeStart)

    const previous = readMetadata(lastShiftMetadata)
    let summary = previous.summary
    let evidence = previous.evidence
    const coveredItemCount = Math.min(previous.coveredItemCount, exchangeStart)

    // Level 1: fold only the older exchanges NOT yet covered by the rolling
    // summary — the cursor is what keeps repeated shifts from re-summarizing
    // (and re-appending) the same span every time.
    const toFold = rest.slice(coveredItemCount, exchangeStart)
    if (toFold.length > 0) {
      const foldItems = applyEvidenceToItems(toFold, coveredItemCount, evidence)
      summary =
        (await foldIntoRollingSummary({
          items: foldItems,
          previousSummary: summary,
          renderTranscript: (items) =>
            renderChatHistoryItemsForSummary(items, deps.stringifySystemText),
          itemTranscriptCost: (item) => countTokens(renderItem(item, deps.stringifySystemText)),
          countTokens,
          summarize: deps.summarize
        })) ?? summary
      // The evidence item is now fully represented in the summary.
      if (evidence && evidence.itemIndex < exchangeStart) evidence = undefined
    }

    let systemWithSummary = buildSystemItemWithSummary(originalSystemText, summary)
    let remainingBudget = Math.max(0, targetBudget - countTokens(systemWithSummary.text as string))

    const exchangeCost = newestExchange.reduce(
      (sum, item) => sum + fullItemCost(item, countTokens),
      0
    )
    let foldedEvidenceCallCount = 0
    const fitExchange = (): ChatHistoryItem[] => {
      let fitted = trimNewestExchangeToFit(newestExchange, remainingBudget, countTokens)
      if (!chatWrapper) return fitted

      // Measure the same wrapper-rendered form node-llama-cpp checks. Each
      // refinement starts from canonical history at a tighter plain budget;
      // the bound covers every response part plus a final no-progress pass.
      const maxRefinementPasses =
        newestExchange.reduce(
          (sum, item) => sum + (item.type === 'model' ? item.response.length : 1),
          0
        ) + 1
      let previousRefit = remainingBudget + 1
      for (let pass = 0; pass < maxRefinementPasses; pass++) {
        const candidate = [systemWithSummary, ...fitted]
        const rendered = renderedTokenCost(candidate, chatWrapper, tokenizer)
        if (rendered == null || rendered <= targetBudget) break
        const plain = candidate.reduce((sum, item) => sum + fullItemCost(item, countTokens), 0)
        const overhead = Math.max(0, rendered - plain)
        const refit = Math.max(
          0,
          targetBudget - overhead - countTokens(systemWithSummary.text as string)
        )
        if (refit >= previousRefit) break
        previousRefit = refit
        fitted = trimNewestExchangeToFit(newestExchange, refit, countTokens)
      }

      const rendered = renderedTokenCost([systemWithSummary, ...fitted], chatWrapper, tokenizer)
      if (rendered == null || rendered <= targetBudget) return fitted

      // Estimate-based refinement can still miss non-linear wrapper floors
      // around function-call syntax. Search the newest-exchange budget against
      // the real rendered fit check before returning a strategy result.
      let low = 0
      let high = remainingBudget
      let best: ChatHistoryItem[] | null = null
      while (low <= high) {
        const mid = Math.floor((low + high) / 2)
        const candidate = trimNewestExchangeToFit(newestExchange, mid, countTokens)
        const candidateRendered = renderedTokenCost(
          [systemWithSummary, ...candidate],
          chatWrapper,
          tokenizer
        )
        if (candidateRendered == null || candidateRendered <= targetBudget) {
          best = candidate
          low = mid + 1
        } else {
          high = mid - 1
        }
      }
      return best ?? trimNewestExchangeToFit(newestExchange, 0, countTokens)
    }

    // Level 2: fit the newest exchange, inspect which original calls were
    // actually changed/dropped, fold that entire prefix, then refit after the
    // summary grows. Repeat to a fixpoint so summary growth and wrapper
    // overhead can never trim evidence beyond the metadata cursor.
    const evidenceTarget = findEvidenceTarget(newestExchange)
    const absoluteEvidenceIndex = evidenceTarget
      ? exchangeStart + evidenceTarget.localItemIndex
      : null
    let foldedSoFar =
      absoluteEvidenceIndex != null && evidence?.itemIndex === absoluteEvidenceIndex
        ? Math.min(evidence.callCount, evidenceTarget?.functionCalls.length ?? 0)
        : 0
    let finalExchange = fitExchange()

    if (evidenceTarget && absoluteEvidenceIndex != null) {
      for (let pass = 0; pass <= evidenceTarget.functionCalls.length; pass++) {
        const affectedEnd = affectedFunctionCallPrefixEnd(
          evidenceTarget.functionCalls,
          finalExchange[evidenceTarget.localItemIndex]
        )
        if (affectedEnd <= foldedSoFar) break

        const callsToFold = evidenceTarget.functionCalls.slice(foldedSoFar, affectedEnd)
        summary =
          (await foldIntoRollingSummary<ChatModelFunctionCall>({
            items: callsToFold,
            previousSummary: summary,
            renderTranscript: (calls) => calls.map(renderFunctionCall).join('\n'),
            itemTranscriptCost: (call) => countTokens(renderFunctionCall(call)),
            countTokens,
            summarize: deps.summarize
          })) ?? summary
        foldedEvidenceCallCount += callsToFold.length
        foldedSoFar = affectedEnd
        evidence = { itemIndex: absoluteEvidenceIndex, callCount: foldedSoFar }

        systemWithSummary = buildSystemItemWithSummary(originalSystemText, summary)
        remainingBudget = Math.max(0, targetBudget - countTokens(systemWithSummary.text as string))
        finalExchange = fitExchange()
      }
    }

    if (chatWrapper) {
      const fittedRendered = renderedTokenCost(
        [systemWithSummary, ...finalExchange],
        chatWrapper,
        tokenizer
      )
      if (fittedRendered != null && fittedRendered > targetBudget) {
        const shrunk = shrinkSummaryForRenderedFit(
          originalSystemText,
          summary,
          chatWrapper,
          tokenizer,
          countTokens,
          targetBudget,
          finalExchange
        )
        systemWithSummary = shrunk.systemItem
        summary = shrunk.summary
        remainingBudget = Math.max(0, targetBudget - countTokens(systemWithSummary.text as string))
        finalExchange = fitExchange()
      }
    }

    const finalExchangeCost = finalExchange.reduce(
      (sum, item) => sum + fullItemCost(item, countTokens),
      0
    )
    const trimDetails = newestExchangeTrimDetails(newestExchange, finalExchange)
    const trimmedNewestExchange =
      finalExchangeCost < exchangeCost ||
      trimDetails.trimmedUserMessage ||
      trimDetails.trimmedAssistantResponse

    try {
      deps.onShift?.({
        foldedItemCount: toFold.length,
        foldedEvidenceCallCount,
        trimmedNewestExchange,
        ...trimDetails,
        summaryTokens: summary ? countTokens(summary) : 0
      })
    } catch {
      // See `onShift`'s doc comment — observability must never fail the shift.
    }

    return {
      chatHistory: [systemWithSummary, ...finalExchange],
      metadata: { summary, coveredItemCount: exchangeStart, evidence }
    }
  }
}

/**
 * When level-1 folding reaches the item the level-2 evidence cursor points
 * at (the mega-turn finally aged out of the newest exchange), its
 * already-folded calls' results are replaced with a marker so the summarizer
 * doesn't ingest — and the summary doesn't double-represent — content that
 * was already folded mid-turn.
 */
function applyEvidenceToItems(
  items: readonly ChatHistoryItem[],
  startIndex: number,
  evidence: { itemIndex: number; callCount: number } | undefined
): readonly ChatHistoryItem[] {
  if (!evidence) return items
  const localIndex = evidence.itemIndex - startIndex
  if (localIndex < 0 || localIndex >= items.length) return items
  const target = items[localIndex]
  if (target.type !== 'model') return items

  let callOrdinal = 0
  const response = target.response.map((part) => {
    if (!isFunctionCall(part)) return part
    callOrdinal += 1
    return callOrdinal <= evidence.callCount ? { ...part, result: ALREADY_SUMMARIZED_MARKER } : part
  })
  const next = [...items]
  next[localIndex] = { ...target, response }
  return next
}
