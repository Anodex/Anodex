import type { ChatHistoryTurn } from '@shared/chat.types'
import type { ConversationContext } from '@shared/context.types'
import type { ToolCall } from '@shared/tools.types'
import { sanitizeHistoryTurn } from '@shared/chatSanitizer'
import { MAX_MODEL_TOOL_RESULT_CHARS } from '@shared/contextBudget'
import { APPROX_CHARS_PER_TOKEN } from '@shared/contextProjection'
import {
  buildCompactionSystemPrompt,
  CLOUD_SUMMARY_CHUNK_TOKEN_BUDGET,
  MIN_CHARS_TO_SUMMARIZE,
  renderTurnsForSummary,
  reservedNonHistoryTokens,
  splitHistoryByTokenBudget,
  turnTokenCost
} from './compaction'
import { foldIntoRollingSummary, type RollingSummarizer } from './rollingSummary'

/**
 * Maximum remembered output per past tool call when rebuilding model context.
 *
 * The chat UI may retain richer tool details for display, but replaying large
 * reads, command logs, or generated file contents verbatim makes old tool
 * output crowd out the user's latest request. Keep the model-facing record
 * concise and self-describing; the model can ask to read the file/rerun the
 * command when it truly needs the omitted detail.
 */
export { MAX_MODEL_TOOL_RESULT_CHARS } from '@shared/contextBudget'

const TOOL_RESULT_TRUNCATION_NOTICE =
  '\n\n[Anodex truncated this older tool result for context. Re-read or rerun it if exact detail is needed.]'

export interface ModelContextReport {
  /** Full sanitized turns before budget splitting. */
  originalTurns: number
  /** Turns retained verbatim in the projected model context. */
  recentTurns: number
  /** Turns omitted from verbatim replay because the projected context was full. */
  removedTurns: number
  /** Whether older omitted turns were represented by a summary in the system prompt. */
  summarized: boolean
  /** Token budget available to chat history after system/reserved tokens. */
  historyBudgetTokens: number
  /** Approximate tokens consumed by the retained projected turns. */
  historyTokens: number
  /** Approximate tokens consumed by the final system prompt, including summary if present. */
  systemTokens: number
}

export interface ModelContextAssembly {
  systemPrompt: string | undefined
  history: ChatHistoryTurn[]
  removedTurns: number
  summarized: boolean
  /** New summary created during this assembly, excluding any previously persisted snapshot. */
  summary?: string
  /** Last original message represented by `summary`, if known. */
  compactedThroughMessageId?: string | null
  report: ModelContextReport
}

export interface SnapshotSeededContext {
  systemPrompt: string | undefined
  history: ChatHistoryTurn[]
  applied: boolean
  summary?: string
  throughMessageId?: string | null
}

export interface ModelContextAssemblyInput {
  systemPrompt: string | undefined
  history: ChatHistoryTurn[]
  contextSize: number
  countTokens: (text: string) => number
  /**
   * Replacement-style rolling summarizer (see `RollingSummarizer` in
   * `rollingSummary.ts`): receives one bounded transcript chunk plus the
   * previous rolling summary and returns the complete updated summary.
   * Overflowing turns are fed to it chunk-by-chunk via
   * `foldIntoRollingSummary`, never as one unbounded transcript — the
   * summarizer's own context is small (4,096 tokens for the local engine).
   */
  summarizeOlderTurns: RollingSummarizer
  /** Fixed tool-schema cost reserved in addition to system/reply room (local provider). */
  toolSchemaReserveTokens?: number
  /**
   * Per-chunk transcript budget for the fold — defaults to the local
   * engine's `SUMMARY_CHUNK_TOKEN_BUDGET`. Cloud callers pass
   * `CLOUD_SUMMARY_CHUNK_TOKEN_BUDGET` so one big overflow doesn't become a
   * long series of small paid API calls (see that constant's doc comment).
   */
  summaryChunkTokenBudget?: number
  /**
   * Per-message framing the caller's transport pays and this assembly's
   * character-based estimate cannot see. See `turnTokenCost` in
   * `compaction.ts`; 0 (the default) preserves the prior behaviour.
   */
  messageFramingTokens?: number
  /**
   * Fraction of the history budget the replay may keep verbatim; the rest is
   * summarized/dropped. `null`/omitted keeps the historical greedy behaviour
   * (history fills the whole budget). Headroom mode passes a fraction (see
   * `DEFAULT_REPLAY_CAP_FRACTION` in `contextBudget.ts`) so a rebuilt session
   * starts well below the compaction trigger and has room to refill. The
   * node-llama-cpp engine sets this; `boundHistoryForStatelessProvider` never
   * does, so cloud/stateless transports stay greedy.
   */
  replayCapFraction?: number | null
}

/**
 * Build the projected conversation sent to the model.
 *
 * This is intentionally separate from the persisted chat transcript: Anodex
 * keeps the full conversation for the user and auditability, while the model
 * receives a bounded, sanitized projection optimized for the next turn.
 */
export async function assembleModelContext({
  systemPrompt,
  history,
  contextSize,
  countTokens,
  summarizeOlderTurns,
  toolSchemaReserveTokens = 0,
  summaryChunkTokenBudget,
  messageFramingTokens = 0,
  replayCapFraction
}: ModelContextAssemblyInput): Promise<ModelContextAssembly> {
  const projectedHistory = projectHistoryForModel(history)
  const initialBudget = historyBudgetTokens(
    systemPrompt,
    contextSize,
    countTokens,
    toolSchemaReserveTokens,
    replayCapFraction
  )
  const split = splitHistoryByTokenBudget(
    projectedHistory,
    initialBudget,
    countTokens,
    messageFramingTokens
  )

  let older = split.older
  let projectedRecent = split.recent
  let summary = await summarizeTurns(older, summarizeOlderTurns, countTokens, {
    chunkTokenBudget: summaryChunkTokenBudget
  })
  let projectedSystemPrompt = summary
    ? buildCompactionSystemPrompt(systemPrompt, summary)
    : systemPrompt

  if (summary) {
    // If the summary itself pushes some "recent" turns out of budget, fold
    // those turns into the rolling summary so the projected context has no
    // unsummarized gap between the summary and verbatim replay. Only the
    // NEWLY overflowing turns are folded (with the existing summary as the
    // rolling base) — re-summarizing the whole accumulated `older` slice
    // from scratch each pass, as this used to, redoes work and can feed the
    // summarizer an ever-larger transcript. A pass whose new slice is too
    // small to summarize (`null`) keeps the summary it already has and
    // drops just those few turns, instead of the old all-or-nothing
    // drop-everything fallback.
    // Each pass removes at least one turn from `projectedRecent`, so this
    // converges in at most the number of retained turns. A fixed pass count
    // is not sufficient: a replacement summary can grow again on pass 2 and
    // push yet another turn over the newly reduced budget.
    while (projectedRecent.length > 0) {
      const budget = historyBudgetTokens(
        projectedSystemPrompt,
        contextSize,
        countTokens,
        toolSchemaReserveTokens,
        replayCapFraction
      )
      const finalSplit = splitHistoryByTokenBudget(
        projectedRecent,
        budget,
        countTokens,
        messageFramingTokens
      )
      projectedRecent = finalSplit.recent
      if (finalSplit.older.length === 0) break

      older = [...older, ...finalSplit.older]
      const expandedSummary = await summarizeTurns(
        finalSplit.older,
        summarizeOlderTurns,
        countTokens,
        {
          previousSummary: summary,
          chunkTokenBudget: summaryChunkTokenBudget
        }
      )
      if (expandedSummary) {
        summary = expandedSummary
        projectedSystemPrompt = buildCompactionSystemPrompt(systemPrompt, summary)
      }
    }
  }

  const finalBudget = historyBudgetTokens(
    projectedSystemPrompt,
    contextSize,
    countTokens,
    toolSchemaReserveTokens,
    replayCapFraction
  )
  const removedTurns = older.length

  return {
    systemPrompt: projectedSystemPrompt,
    history: projectedRecent,
    removedTurns,
    summarized: summary !== null,
    summary: summary ?? undefined,
    compactedThroughMessageId: summary ? lastTurnId(older) : undefined,
    report: {
      originalTurns: projectedHistory.length,
      recentTurns: projectedRecent.length,
      removedTurns,
      summarized: summary !== null,
      historyBudgetTokens: finalBudget,
      historyTokens: historyTokens(projectedRecent, countTokens, messageFramingTokens),
      systemTokens: countTokens(projectedSystemPrompt ?? '')
    }
  }
}

/**
 * Apply a persisted context snapshot before doing any new budget splitting.
 *
 * This mirrors OpenCode's context-epoch idea: old turns remain in the saved
 * conversation, but the active model context begins from the durable summary
 * plus exact turns after the snapshot boundary.
 */
export function seedContextFromSnapshot(
  systemPrompt: string | undefined,
  history: ChatHistoryTurn[],
  context: ConversationContext | null | undefined
): SnapshotSeededContext {
  const snapshot = context?.activeSnapshot
  if (!snapshot?.summary || !snapshot.throughMessageId) {
    return { systemPrompt, history: projectHistoryForModel(history), applied: false }
  }

  const projectedHistory = projectHistoryForModel(history)
  const boundaryIndex = projectedHistory.findIndex((turn) => turn.id === snapshot.throughMessageId)
  if (boundaryIndex < 0) {
    return { systemPrompt, history: projectedHistory, applied: false }
  }

  return {
    systemPrompt: buildCompactionSystemPrompt(systemPrompt, snapshot.summary),
    history: projectedHistory.slice(boundaryIndex + 1),
    applied: true,
    summary: snapshot.summary,
    throughMessageId: snapshot.throughMessageId
  }
}

export interface CloudBoundedContext {
  systemPrompt: string | undefined
  history: ChatHistoryTurn[]
  /** Older turns removed from this turn's context, summarized or dropped. */
  omittedTurns: number
  /** Whether `omittedTurns` were actually condensed into a summary, vs. just dropped. */
  summarized: boolean
  /** New summary created this call, if any (excludes a previously persisted snapshot). */
  summary?: string
  /** Last original message represented by `summary`, if known. */
  compactedThroughMessageId?: string | null
}

/**
 * Bound history for a **stateless** provider — one that re-sends the whole
 * conversation on every request and so has no session of its own to compact
 * inside. That covers the cloud providers (OpenAI/Anthropic/Azure, whose
 * tokens Anodex estimates from character count) and, despite the "cloud"
 * heritage of this code, Anodex's own llama-server transport in
 * `LlamaVisionService`, which is stateless in exactly the same way.
 *
 * Always applies the same persisted-snapshot seeding the local engine uses.
 * With no `summarizeOlderTurns` supplied, turns that don't fit are dropped,
 * never summarized (used before a summarizer existed, and still the fallback
 * if a caller doesn't have one). With one supplied, delegates to the same
 * `assembleModelContext` pipeline the local engine uses, so these
 * conversations get the identical summarize-and-fold-back behavior — just
 * with a different model doing the summarizing.
 *
 * `summaryChunkTokenBudget` sizes each transcript chunk handed to the
 * summarizer, and must match the context that summarizer actually runs in:
 * a cloud model gets `CLOUD_SUMMARY_CHUNK_TOKEN_BUDGET`, while a local one
 * gets a budget derived from its real context (see
 * `summaryChunkBudgetForContext`) — feeding cloud-sized chunks to a small
 * local context would overflow the very call meant to relieve the overflow.
 *
 * `options.toolSchemaReserveTokens` is not optional in spirit, only in
 * signature. Tool schemas are fixed prompt overhead that no amount of history
 * compaction can shrink, and a caller that omits them plans against a budget
 * short by their entire cost — the shortfall then lands on the reply, since
 * history is bounded before the transport ever measures the real prompt. The
 * node-llama-cpp path has always reserved for this (`LlamaService.generate`);
 * every stateless transport pays the same overhead and needs the same reserve.
 */
export async function boundHistoryForStatelessProvider(
  systemPrompt: string | undefined,
  history: ChatHistoryTurn[],
  context: ConversationContext | null | undefined,
  contextWindowTokens: number,
  summarizeOlderTurns?: RollingSummarizer,
  summaryChunkTokenBudget: number = CLOUD_SUMMARY_CHUNK_TOKEN_BUDGET,
  options?: { toolSchemaReserveTokens?: number; messageFramingTokens?: number }
): Promise<CloudBoundedContext> {
  const seeded = seedContextFromSnapshot(systemPrompt, history, context)
  const toolSchemaReserveTokens = options?.toolSchemaReserveTokens ?? 0
  const messageFramingTokens = options?.messageFramingTokens ?? 0

  if (!summarizeOlderTurns) {
    const budget = historyBudgetTokens(
      seeded.systemPrompt,
      contextWindowTokens,
      estimateTokensApprox,
      toolSchemaReserveTokens
    )
    const split = splitHistoryByTokenBudget(
      seeded.history,
      budget,
      estimateTokensApprox,
      messageFramingTokens
    )
    return {
      systemPrompt: seeded.systemPrompt,
      history: split.recent,
      omittedTurns: split.older.length,
      summarized: false
    }
  }

  const assembled = await assembleModelContext({
    systemPrompt: seeded.systemPrompt,
    history: seeded.history,
    contextSize: contextWindowTokens,
    countTokens: estimateTokensApprox,
    summarizeOlderTurns,
    summaryChunkTokenBudget,
    toolSchemaReserveTokens,
    messageFramingTokens
  })

  return {
    systemPrompt: assembled.systemPrompt,
    history: assembled.history,
    omittedTurns: assembled.removedTurns,
    summarized: assembled.summarized,
    summary: mergeContextSummaries(seeded.summary, assembled.summary),
    compactedThroughMessageId:
      assembled.compactedThroughMessageId ?? seeded.throughMessageId ?? null
  }
}

/**
 * Character-based token estimate — the same conservative approximation the
 * renderer's context meter uses (`contextProjection.ts`), reused here since
 * Anodex has no real tokenizer for cloud models the way it does for the local
 * engine (`LlamaModel.tokenize`).
 */
function estimateTokensApprox(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN)
}

/**
 * Combine the prior context epoch summary with a newly compacted chunk.
 * Shared by the local engine and `boundHistoryForStatelessProvider` — both fold
 * a persisted snapshot's summary together with whatever gets freshly
 * compacted in the same turn.
 */
export function mergeContextSummaries(
  previous: string | undefined,
  next: string | undefined
): string | undefined {
  if (!previous) return next
  if (!next) return previous
  return `${previous}\n\nAdditional compacted context:\n${next}`
}

/**
 * Fold `turns` into a bounded rolling summary via `foldIntoRollingSummary`,
 * chunking so no single summarizer call receives more transcript than its
 * small dedicated context can hold — the old single-call version handed the
 * entire overflow transcript over at once, which for a long-lived
 * conversation exceeded the summarizer's 4,096-token context and silently
 * degraded to dropping the turns unsummarized. Returns `null` when the slice
 * is too small to be worth summarizing (callers drop those turns, as
 * before).
 */
async function summarizeTurns(
  turns: ChatHistoryTurn[],
  summarizeOlderTurns: RollingSummarizer,
  countTokens: (text: string) => number,
  options?: { previousSummary?: string; chunkTokenBudget?: number }
): Promise<string | null> {
  if (turns.length === 0) return null
  const transcript = renderTurnsForSummary(turns)
  // Skipping a tiny INITIAL slice is a worthwhile round-trip optimization.
  // Once a rolling summary already exists, however, newly overflowing turns
  // must still be folded into it (the primitive uses a deterministic digest
  // for tiny chunks); otherwise the snapshot boundary advances past turns
  // that the summary never represented.
  if (transcript.length < MIN_CHARS_TO_SUMMARIZE && !options?.previousSummary) return null
  const folded = await foldIntoRollingSummary({
    items: turns,
    previousSummary: options?.previousSummary,
    renderTranscript: renderTurnsForSummary,
    itemTranscriptCost: (turn) => countTokens(renderTurnsForSummary([turn])),
    countTokens,
    summarize: summarizeOlderTurns,
    chunkTokenBudget: options?.chunkTokenBudget
  })
  return folded ?? null
}

/** Sanitize transcript text and bound remembered tool output before model replay. */
export function projectHistoryForModel(history: ChatHistoryTurn[]): ChatHistoryTurn[] {
  return history.map((rawTurn) => {
    const turn = sanitizeHistoryTurn(rawTurn)
    if (turn.role !== 'assistant' || !turn.toolCalls?.length) return turn
    return {
      ...turn,
      toolCalls: turn.toolCalls.map(projectToolCallForModel)
    }
  })
}

/** Return the compact, model-facing version of a tool call. */
export function projectToolCallForModel(call: ToolCall): ToolCall {
  return {
    ...call,
    result: call.result ? truncateToolText(call.result) : call.result,
    detail: call.detail && !call.result ? truncateToolText(call.detail) : call.detail
  }
}

/** A compact, self-describing record of a past tool call for replay. */
export function rememberToolCallForModel(call: ToolCall): string {
  const projected = projectToolCallForModel(call)
  const body = projected.result ?? projected.detail ?? ''
  return body ? `${projected.title}\n${body}` : projected.title
}

/**
 * Token ceiling history replay may fill for the given window. After
 * system/reserved/tool-schema subtraction, an optional `replayCapFraction`
 * (Headroom mode) keeps only that share for verbatim replay — the rest must be
 * summarized or dropped. `null`/omitted is the historical greedy behaviour.
 * Exported so the exact cap maths can be unit-tested against the shared
 * `estimateProjectedContextUsage` mirror.
 */
export function historyBudgetTokens(
  systemPrompt: string | undefined,
  contextSize: number,
  countTokens: (text: string) => number,
  toolSchemaReserveTokens = 0,
  replayCapFraction?: number | null
): number {
  const budget =
    contextSize -
    countTokens(systemPrompt ?? '') -
    reservedNonHistoryTokens(contextSize) -
    Math.max(0, toolSchemaReserveTokens)
  if (replayCapFraction != null && Number.isFinite(replayCapFraction)) {
    return Math.max(0, Math.floor(budget * replayCapFraction))
  }
  return Math.max(0, budget)
}

/**
 * What the retained turns actually cost, measured the same way the budget that
 * selected them was.
 *
 * This had its own hand-rolled sum, and it disagreed with `turnTokenCost` in
 * two directions at once: it charged nothing for per-message framing, and
 * nothing for a tool call's title — so a call that recorded a title and no
 * result counted as zero. The figure it produces is what a developer reads out
 * of the compaction log while working out why a turn overflowed, and it read
 * low, which is the one direction that misleads.
 */
function historyTokens(
  history: ChatHistoryTurn[],
  countTokens: (text: string) => number,
  messageFramingTokens: number
): number {
  return history.reduce(
    (total, turn) => total + turnTokenCost(turn, countTokens, messageFramingTokens),
    0
  )
}

function truncateToolText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n')
  if (normalized.length <= MAX_MODEL_TOOL_RESULT_CHARS) return normalized
  return `${normalized.slice(0, MAX_MODEL_TOOL_RESULT_CHARS).trimEnd()}${TOOL_RESULT_TRUNCATION_NOTICE}`
}

function lastTurnId(turns: ChatHistoryTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const id = turns[i]?.id
    if (id) return id
  }
  return null
}
