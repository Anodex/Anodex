import type { ChatHistoryTurn } from '@shared/chat.types'
import {
  MAX_RESERVED_NON_HISTORY_TOKENS,
  MIN_RESERVED_NON_HISTORY_TOKENS,
  RESERVED_NON_HISTORY_FRACTION,
  reservedNonHistoryTokens
} from '@shared/contextBudget'
import { sanitizeHistoryTurn } from '@shared/chatSanitizer'

/**
 * Fraction of the context window reserved for the system prompt's tool
 * schemas plus the model's own response, on top of the system prompt's own
 * measured token count. Scales with `contextSize` rather than a flat token
 * count — mirrors the existing `maxTokens = contextSize * 0.25` recommendation
 * in `LlamaService.recommendSettingsForFile`. A flat reservation would either
 * swallow a small context whole (e.g. 2048 reserved out of a 3072-token
 * context leaves almost no history budget at all) or waste a large one (2048
 * out of 128K is needlessly stingy for a big context's own response).
 */
export {
  MAX_RESERVED_NON_HISTORY_TOKENS,
  MIN_RESERVED_NON_HISTORY_TOKENS,
  RESERVED_NON_HISTORY_FRACTION,
  reservedNonHistoryTokens
}

/**
 * Below this combined character count, older turns are dropped outright
 * instead of summarized — not worth an extra LLM round-trip to condense a
 * couple of short turns down to almost the same size.
 */
export const MIN_CHARS_TO_SUMMARIZE = 200

/**
 * Fraction of the context window's native KV-cache usage that triggers a
 * proactive mid-conversation compaction (see `LlamaService.generate()`).
 * Deliberately well below 1.0 so compaction runs before node-llama-cpp's own
 * internal context shift ever has to.
 */
export const COMPACTION_TRIGGER_RATIO = 0.85

/** Target length for the compaction summary — generous, since it may need to
 *  cover many turns, unlike the ~8-word toast summary. */
export const MAX_COMPACTION_SUMMARY_WORDS = 350

/**
 * Below this length, a "summary" is treated as a failed/degenerate response
 * (e.g. a weak model latching onto a short reply embedded in the transcript,
 * like a literal "OK") rather than a real summary — the caller falls back to
 * dropping the older turns instead of keeping a useless one-word "summary".
 */
export const MIN_SUMMARY_CHARS = 30

/**
 * Substring of node-llama-cpp's own internal crash message, thrown when its
 * default context-shift strategy still doesn't fit history into the context
 * after erasing (see `compressHistoryToFitContextSize` in
 * `node_modules/node-llama-cpp/dist/evaluator/LlamaChat/LlamaChat.js`).
 * node-llama-cpp exposes no error class or code for this — just a plain
 * `new Error(string)` — so `LlamaService`'s reactive safety net has no way
 * to detect it other than matching this text, which could silently stop
 * matching on a future node-llama-cpp upgrade. See the trip-wire test in
 * `__tests__/compaction.test.ts` that reads the actual installed
 * node-llama-cpp source and fails loudly if this fragment ever goes stale,
 * instead of the safety net quietly going dark in production.
 */
export const NODE_LLAMA_CPP_CONTEXT_SHIFT_CRASH_FRAGMENT =
  'did not return a history that fits the context size'

export interface HistorySplit {
  /** Turns that fit within budget verbatim, oldest-first. */
  recent: ChatHistoryTurn[]
  /** Older turns that need to be summarized or dropped, oldest-first. */
  older: ChatHistoryTurn[]
}

/** Token cost of a single turn: its content plus any tool-call results. */
function turnTokenCost(turn: ChatHistoryTurn, countTokens: (text: string) => number): number {
  const sanitized = sanitizeHistoryTurn(turn)
  let cost = countTokens(sanitized.content)
  for (const call of sanitized.toolCalls ?? []) {
    cost += countTokens(call.result ?? call.detail ?? '')
  }
  return cost
}

/**
 * Split history into turns that fit within `budgetTokens` (kept verbatim,
 * newest-first while walking, then reversed to oldest-first) and older turns
 * that don't. `countTokens` is injected so this stays unit-testable without a
 * real model loaded.
 *
 * The newest turn is always kept, even if it alone exceeds `budgetTokens` —
 * dropping the turn the user is actively in the middle of would be worse
 * than a tight fit. But if that single turn is capped in place (see
 * `capTurnToTokenBudget`) when it's the *only* kept turn, so the rebuilt
 * session is guaranteed to actually fit. Without this, an outsized turn
 * (observed directly: 35 tool calls in one exchange, each with a real
 * result) stays oversized through every subsequent "successful" compaction —
 * node-llama-cpp's own context-shift crash recurs on every later turn,
 * permanently wedging the conversation, since nothing ever shrinks the one
 * turn actually responsible.
 */
export function splitHistoryByTokenBudget(
  history: ChatHistoryTurn[],
  budgetTokens: number,
  countTokens: (text: string) => number
): HistorySplit {
  if (history.length === 0) return { recent: [], older: [] }

  let total = 0
  const keepIndices: number[] = []
  for (let i = history.length - 1; i >= 0; i--) {
    const cost = turnTokenCost(history[i], countTokens)
    if (total + cost > budgetTokens && keepIndices.length > 0) break
    total += cost
    keepIndices.unshift(i)
  }

  const firstKeptIndex = keepIndices[0] ?? history.length
  const recent = keepIndices.map((i) => history[i])
  if (recent.length === 1) {
    recent[0] = capTurnToTokenBudget(recent[0], budgetTokens, countTokens)
  }

  return {
    recent,
    older: history.slice(0, firstKeptIndex)
  }
}

/**
 * Trim a single oversized turn's tool-call results — oldest first, since the
 * most recent calls are the ones most likely to matter for continuing the
 * conversation — until it fits `budgetTokens`. Leaves the turn's own text
 * content untouched; that's rarely what makes a turn oversized (a long run of
 * tool calls, each with a real result, is), and losing the model's own words
 * would be more damaging than losing an old tool result the UI transcript
 * still has in full anyway (only the model-facing replay copy is capped).
 */
function capTurnToTokenBudget(
  turn: ChatHistoryTurn,
  budgetTokens: number,
  countTokens: (text: string) => number
): ChatHistoryTurn {
  if (!turn.toolCalls?.length) return turn

  const callCosts = turn.toolCalls.map((call) => countTokens(call.result ?? call.detail ?? ''))
  let total = countTokens(turn.content) + callCosts.reduce((sum, cost) => sum + cost, 0)
  if (total <= budgetTokens) return turn

  const notice = '(result omitted to fit context)'
  const noticeCost = countTokens(notice)
  const toolCalls = [...turn.toolCalls]
  for (let i = 0; i < toolCalls.length && total > budgetTokens; i++) {
    const call = toolCalls[i]
    if (!call.result && !call.detail) continue
    if (callCosts[i] <= noticeCost) continue // already cheaper than the notice would be
    total += noticeCost - callCosts[i]
    toolCalls[i] = { ...call, result: notice, detail: notice }
  }
  return { ...turn, toolCalls }
}

/**
 * Truncation length for a tool call's result/detail text when rendered into
 * the summarizer transcript — keeps one large tool result (e.g. a big file
 * read) from dominating the token budget `turnTokenCost` already charged it
 * against.
 */
const TOOL_RESULT_PREVIEW_CHARS = 300

/** Flatten older turns into a plain transcript to feed to the summarizer. */
export function renderTurnsForSummary(turns: ChatHistoryTurn[]): string {
  return turns
    .map((turn) => {
      const sanitized = sanitizeHistoryTurn(turn)
      if (sanitized.role === 'user') return `User: ${sanitized.content}`
      const calls = (sanitized.toolCalls ?? [])
        .map((call) => {
          // Same fallback chain as `turnTokenCost` — otherwise the
          // transcript summarized here can omit the actual tool output
          // (`result`) that was just counted toward the turn's token cost,
          // rendering only its `detail`/`status` instead.
          const text = call.result ?? call.detail ?? call.status
          const preview =
            text.length > TOOL_RESULT_PREVIEW_CHARS
              ? `${text.slice(0, TOOL_RESULT_PREVIEW_CHARS)}…`
              : text
          return ` [called ${call.name} → ${preview}]`
        })
        .join('')
      return `Assistant: ${sanitized.content}${calls}`
    })
    .join('\n')
}

export { buildCompactionSystemPrompt } from '@shared/contextPrompt'
