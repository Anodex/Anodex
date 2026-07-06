import type { ChatHistoryTurn } from '@shared/chat.types'

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
export const RESERVED_NON_HISTORY_FRACTION = 0.2

/** Floor so even a tiny context still leaves some room for a real response. */
export const MIN_RESERVED_NON_HISTORY_TOKENS = 512

/** Ceiling so a huge context doesn't reserve a proportionally huge, wasteful chunk. */
export const MAX_RESERVED_NON_HISTORY_TOKENS = 8192

/** Non-history token reservation for a given context size — see `RESERVED_NON_HISTORY_FRACTION`. */
export function reservedNonHistoryTokens(contextSize: number): number {
  return Math.min(
    MAX_RESERVED_NON_HISTORY_TOKENS,
    Math.max(MIN_RESERVED_NON_HISTORY_TOKENS, Math.round(contextSize * RESERVED_NON_HISTORY_FRACTION))
  )
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
  let cost = countTokens(turn.content)
  for (const call of turn.toolCalls ?? []) {
    cost += countTokens(call.result ?? call.detail ?? '')
  }
  return cost
}

/**
 * Split history into turns that fit within `budgetTokens` (kept verbatim,
 * newest-first while walking, then reversed to oldest-first) and older turns
 * that don't. `countTokens` is injected so this stays unit-testable without a
 * real model loaded.
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
  return {
    recent: keepIndices.map((i) => history[i]),
    older: history.slice(0, firstKeptIndex)
  }
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
      if (turn.role === 'user') return `User: ${turn.content}`
      const calls = (turn.toolCalls ?? [])
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
      return `Assistant: ${turn.content}${calls}`
    })
    .join('\n')
}

/** Append a compaction summary to the system prompt as its own clearly-labeled block. */
export function buildCompactionSystemPrompt(systemPrompt: string | undefined, summary: string): string {
  const base = systemPrompt ?? ''
  const block = `Summary of earlier conversation (compacted to fit the context window):\n${summary}`
  return base ? `${base}\n\n---\n${block}` : block
}
