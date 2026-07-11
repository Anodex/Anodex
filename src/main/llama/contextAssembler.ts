import type { ChatHistoryTurn } from '@shared/chat.types'
import type { ConversationContext } from '@shared/context.types'
import type { ToolCall } from '@shared/tools.types'
import { sanitizeHistoryTurn } from '@shared/chatSanitizer'
import { MAX_MODEL_TOOL_RESULT_CHARS } from '@shared/contextBudget'
import { APPROX_CHARS_PER_TOKEN } from '@shared/contextProjection'
import {
  buildCompactionSystemPrompt,
  MIN_CHARS_TO_SUMMARIZE,
  renderTurnsForSummary,
  reservedNonHistoryTokens,
  splitHistoryByTokenBudget
} from './compaction'

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
  summarizeOlderTurns: (transcript: string) => Promise<string | null>
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
  summarizeOlderTurns
}: ModelContextAssemblyInput): Promise<ModelContextAssembly> {
  const projectedHistory = projectHistoryForModel(history)
  const initialBudget = historyBudgetTokens(systemPrompt, contextSize, countTokens)
  const split = splitHistoryByTokenBudget(projectedHistory, initialBudget, countTokens)

  let older = split.older
  let projectedRecent = split.recent
  let summary = await summarizeTurns(older, summarizeOlderTurns)
  let projectedSystemPrompt = summary
    ? buildCompactionSystemPrompt(systemPrompt, summary)
    : systemPrompt

  if (summary) {
    // If the summary itself pushes some "recent" turns out of budget, fold
    // those turns into a replacement summary so the projected context has no
    // unsummarized gap between the summary and verbatim replay.
    for (let pass = 0; pass < 2; pass++) {
      const budget = historyBudgetTokens(projectedSystemPrompt, contextSize, countTokens)
      const finalSplit = splitHistoryByTokenBudget(projectedRecent, budget, countTokens)
      projectedRecent = finalSplit.recent
      if (finalSplit.older.length === 0) break

      older = [...older, ...finalSplit.older]
      const expandedSummary = await summarizeTurns(older, summarizeOlderTurns)
      if (!expandedSummary) {
        summary = null
        projectedSystemPrompt = systemPrompt
        const fallback = splitHistoryByTokenBudget(projectedHistory, initialBudget, countTokens)
        older = fallback.older
        projectedRecent = fallback.recent
        break
      }
      summary = expandedSummary
      projectedSystemPrompt = buildCompactionSystemPrompt(systemPrompt, summary)
    }
  }

  const finalBudget = historyBudgetTokens(projectedSystemPrompt, contextSize, countTokens)
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
      historyTokens: historyTokens(projectedRecent, countTokens),
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
 * Bound history for a provider with no exact tokenizer of its own (OpenAI/
 * Anthropic — Anodex estimates their tokens from character count instead).
 * Always applies the same persisted-snapshot seeding the local engine uses.
 * With no `summarizeOlderTurns` supplied, turns that don't fit are dropped,
 * never summarized (used before a cloud summarizer existed, and still the
 * fallback if a caller doesn't have one). With one supplied, delegates to the
 * same `assembleModelContext` pipeline the local engine uses, so cloud
 * conversations get the identical summarize-and-fold-back behavior — just
 * with a cloud model doing the summarizing instead of the local engine.
 */
export async function boundHistoryForCloudProvider(
  systemPrompt: string | undefined,
  history: ChatHistoryTurn[],
  context: ConversationContext | null | undefined,
  contextWindowTokens: number,
  summarizeOlderTurns?: (transcript: string) => Promise<string | null>
): Promise<CloudBoundedContext> {
  const seeded = seedContextFromSnapshot(systemPrompt, history, context)

  if (!summarizeOlderTurns) {
    const budget = historyBudgetTokens(
      seeded.systemPrompt,
      contextWindowTokens,
      estimateTokensApprox
    )
    const split = splitHistoryByTokenBudget(seeded.history, budget, estimateTokensApprox)
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
    summarizeOlderTurns
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
 * Shared by the local engine and `boundHistoryForCloudProvider` — both fold
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

async function summarizeTurns(
  turns: ChatHistoryTurn[],
  summarizeOlderTurns: (transcript: string) => Promise<string | null>
): Promise<string | null> {
  if (turns.length === 0) return null
  const transcript = renderTurnsForSummary(turns)
  if (transcript.length < MIN_CHARS_TO_SUMMARIZE) return null
  return summarizeOlderTurns(transcript)
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

function historyBudgetTokens(
  systemPrompt: string | undefined,
  contextSize: number,
  countTokens: (text: string) => number
): number {
  return Math.max(
    0,
    contextSize - countTokens(systemPrompt ?? '') - reservedNonHistoryTokens(contextSize)
  )
}

function historyTokens(history: ChatHistoryTurn[], countTokens: (text: string) => number): number {
  return history.reduce((total, turn) => {
    let next = total + countTokens(turn.content)
    for (const call of turn.toolCalls ?? []) {
      next += countTokens(call.result ?? call.detail ?? '')
    }
    return next
  }, 0)
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
