import type { ChatHistoryTurn, ChatMessage, ContextBudgetUsage } from './chat.types'
import type { ConversationContext } from './context.types'
import type { Conversation } from './conversation.types'
import type { ToolCall } from './tools.types'
import {
  MANUAL_COMPACTION_RECENT_TURNS,
  MAX_MODEL_TOOL_RESULT_CHARS,
  reservedNonHistoryTokens
} from './contextBudget'
import { buildCompactionSystemPrompt } from './contextPrompt'
import { messageToHistoryTurn } from './chatSanitizer'
/**
 * Conservative character/token estimate used in the renderer, where the real
 * model tokenizer is not available. The main process still uses exact model
 * tokenization before building the actual session.
 */
export const APPROX_CHARS_PER_TOKEN = 4

export interface ProjectedContextUsage {
  contextSize: number
  /** Projected pressure: system + active tool schemas + selected history + reply room. */
  usedTokens: number
  pct: number
  systemTokens: number
  historyTokens: number
  toolSchemaTokens: number
  reservedTokens: number
  /** Token ceiling the selected history may reach; `historyTokens` sits under it. */
  historyBudgetTokens: number
  activeToolCount: number
  deferredToolCount: number
  toolRoutingApplied: boolean
  /** Tokens from the persisted snapshot summary, if one was applied. */
  snapshotTokens: number
  recentTurns: number
  omittedTurns: number
  snapshotTurns: number
  totalTurns: number
  snapshotApplied: boolean
}

export interface ManualContextCompactionPlan {
  /** Exact turns to summarize into the next durable snapshot. */
  older: ChatHistoryTurn[]
  /** Exact turns intentionally kept verbatim after the new snapshot boundary. */
  recent: ChatHistoryTurn[]
  /** Summary already stored in the active snapshot, if one was applied. */
  previousSummary?: string
  /** Number of turns represented by the active snapshot before this manual compaction. */
  previousRemovedTurns: number
  /** Last original message represented by the new summary. */
  compactedThroughMessageId: string
  /** Number of exact turns newly folded into the snapshot. */
  compactedTurns: number
}

/** Estimate what the next model turn will see for the active conversation. */
export function estimateProjectedContextUsage({
  conversation,
  contextSize,
  systemPrompt,
  fixedContext,
  replayCapFraction
}: {
  conversation: Conversation
  contextSize: number
  systemPrompt?: string
  /** Exact local wrapper/tokenizer accounting from the latest turn, when available. */
  fixedContext?: ContextBudgetUsage
  /**
   * Fraction of the history budget the engine's Headroom mode replays
   * verbatim (see `LocalProviderSettings.replayCapFraction` /
   * `DEFAULT_REPLAY_CAP_FRACTION`). Must mirror the engine's
   * `historyBudgetTokens` cap or this projection would report the greedy
   * replay while the engine actually replays far less — the very divergence
   * that would stop the meter from resetting honestly.
   */
  replayCapFraction?: number | null
}): ProjectedContextUsage {
  const seeded = seedProjectedHistory(systemPrompt, conversation)
  const exactFixed = fixedContext?.contextSize === contextSize ? fixedContext : undefined
  const reservedTokens = exactFixed?.reservedTokens ?? reservedNonHistoryTokens(contextSize)
  const systemTokens = exactFixed?.systemTokens ?? estimateTokens(seeded.systemPrompt ?? '')
  const toolSchemaTokens = exactFixed?.toolSchemaTokens ?? 0
  let historyBudget = Math.max(0, contextSize - systemTokens - toolSchemaTokens - reservedTokens)
  if (replayCapFraction != null && Number.isFinite(replayCapFraction)) {
    historyBudget = Math.floor(historyBudget * replayCapFraction)
  }
  const split = splitProjectedHistory(seeded.history, historyBudget)
  const historyTokens = split.recent.reduce((sum, turn) => sum + estimateTurnTokens(turn), 0)
  const usedTokens = Math.min(
    contextSize,
    systemTokens + toolSchemaTokens + historyTokens + reservedTokens
  )

  return {
    contextSize,
    usedTokens,
    pct: Math.min(100, Math.round((usedTokens / contextSize) * 100)),
    systemTokens,
    historyTokens,
    historyBudgetTokens: historyBudget,
    toolSchemaTokens,
    reservedTokens,
    activeToolCount: exactFixed?.activeToolCount ?? 0,
    deferredToolCount: exactFixed?.deferredToolCount ?? 0,
    toolRoutingApplied: exactFixed?.toolRoutingApplied ?? false,
    snapshotTokens: seeded.snapshotTokens,
    recentTurns: split.recent.length,
    omittedTurns: split.older.length,
    snapshotTurns: seeded.snapshotTurns,
    totalTurns: conversation.messages.length,
    snapshotApplied: seeded.snapshotApplied
  }
}

/** Plan a manual compaction while keeping the newest turns exact. */
export function planManualContextCompaction(
  history: ChatHistoryTurn[],
  context: ConversationContext | null | undefined,
  recentTurnCount = MANUAL_COMPACTION_RECENT_TURNS
): ManualContextCompactionPlan | null {
  const seeded = seedHistoryFromContext(history, context)
  const splitIndex = Math.max(0, seeded.history.length - recentTurnCount)
  const older = seeded.history.slice(0, splitIndex)
  if (older.length === 0) return null

  const compactedThroughMessageId = lastTurnId(older)
  if (!compactedThroughMessageId) return null

  return {
    older,
    recent: seeded.history.slice(splitIndex),
    previousSummary: seeded.summary,
    previousRemovedTurns: seeded.removedTurns,
    compactedThroughMessageId,
    compactedTurns: older.length
  }
}

/**
 * Build a history turn for the projection only. Unlike `messageToHistoryTurn`
 * (which feeds the engine's replay and compaction and deliberately stays
 * content-only), this folds the message's `thinking` text into `content` so
 * the meter charges for the reasoning tokens that genuinely occupy the KV
 * cache — a reused session retains everything generated last turn, thinking
 * included. Thinking is never scanned for tool-call payloads (see
 * `chatSanitizer.ts`), so it is appended after sanitization, mirroring how the
 * engine treats the separate thinking stream.
 */
function messageToProjectionTurn(message: ChatMessage): ChatHistoryTurn {
  const turn = messageToHistoryTurn(message)
  if (!message.thinking) return turn
  return {
    ...turn,
    content: turn.content ? `${turn.content}\n${message.thinking}` : message.thinking
  }
}

function seedProjectedHistory(
  systemPrompt: string | undefined,
  conversation: Conversation
): {
  systemPrompt: string | undefined
  history: ChatHistoryTurn[]
  snapshotTokens: number
  snapshotTurns: number
  snapshotApplied: boolean
} {
  const history = conversation.messages.map(messageToProjectionTurn)
  const seeded = seedHistoryFromContext(history, conversation.context)
  return {
    systemPrompt: seeded.summary
      ? buildCompactionSystemPrompt(systemPrompt, seeded.summary)
      : systemPrompt,
    history: seeded.history,
    snapshotTokens: seeded.summary ? estimateTokens(seeded.summary) : 0,
    snapshotTurns: seeded.removedTurns,
    snapshotApplied: seeded.applied
  }
}

function seedHistoryFromContext(
  history: ChatHistoryTurn[],
  context: ConversationContext | null | undefined
): {
  history: ChatHistoryTurn[]
  summary?: string
  removedTurns: number
  applied: boolean
} {
  const snapshot = context?.activeSnapshot
  if (!snapshot?.summary || !snapshot.throughMessageId) {
    return {
      history,
      removedTurns: 0,
      applied: false
    }
  }

  const boundaryIndex = history.findIndex((turn) => turn.id === snapshot.throughMessageId)
  if (boundaryIndex < 0) {
    return {
      history,
      removedTurns: 0,
      applied: false
    }
  }

  return {
    history: history.slice(boundaryIndex + 1),
    summary: snapshot.summary,
    removedTurns: snapshot.removedTurns,
    applied: true
  }
}

/**
 * Split history into turns that fit within `budgetTokens` (kept verbatim,
 * newest-first while walking, then reversed to oldest-first) and older turns
 * that don't — a deliberate mirror of the engine's
 * `splitHistoryByTokenBudget` (`compaction.ts`) so the meter's `historyTokens`
 * agrees with what the engine actually replays. The three behaviors that keep
 * them in lockstep:
 *
 * - The newest turn is always kept, even if it alone exceeds the budget.
 * - The kept slice never opens with an orphaned assistant reply — a leading
 *   assistant turn that answers a user question already cut off is dropped
 *   into the older/summarized half instead.
 * - A single kept turn that alone exceeds the budget is capped in place
 *   (`capSingleTurnToBudget`), the same way the engine shrinks an oversized
 *   turn so a rebuilt session still fits.
 */
function splitProjectedHistory(
  history: ChatHistoryTurn[],
  budgetTokens: number
): { recent: ChatHistoryTurn[]; older: ChatHistoryTurn[] } {
  if (history.length === 0) return { recent: [], older: [] }

  let total = 0
  const keepIndices: number[] = []
  for (let i = history.length - 1; i >= 0; i--) {
    const cost = estimateTurnTokens(history[i])
    if (total + cost > budgetTokens && keepIndices.length > 0) break
    total += cost
    keepIndices.unshift(i)
  }

  // Mirror the engine's cut alignment: never down to nothing, and a single
  // kept turn stays even if it is an assistant one (an orphan is a smaller
  // problem than an empty history).
  while (keepIndices.length > 1 && history[keepIndices[0]].role === 'assistant') {
    keepIndices.shift()
  }

  const firstKeptIndex = keepIndices[0] ?? history.length
  const recent = keepIndices.map((i) => history[i])
  if (recent.length === 1) {
    recent[0] = capSingleTurnToBudget(recent[0], budgetTokens)
  }

  return {
    recent,
    older: history.slice(0, firstKeptIndex)
  }
}

function estimateTurnTokens(turn: ChatHistoryTurn): number {
  let total = estimateTokens(turn.content)
  for (const call of turn.toolCalls ?? []) {
    total += estimateTurnToolCallTokens(call)
  }
  return total
}

function estimateTurnToolCallTokens(call: ToolCall): number {
  if (call.status !== 'success' && call.status !== 'error') return 0
  return estimateTokens(compactToolText(call.result ?? call.detail ?? ''))
}

/**
 * Mirror of the engine's `capTurnToTokenBudget` (`compaction.ts`): a single
 * oversized kept turn has its tool-call results trimmed — oldest first, since
 * the most recent calls are most likely to matter — until the whole turn fits
 * `budgetTokens`. Content is never touched, and a call already cheaper than
 * the replacement notice is skipped. Kept internally consistent with
 * `estimateTurnTokens` so the meter reports the same capped cost it charges.
 */
function capSingleTurnToBudget(turn: ChatHistoryTurn, budgetTokens: number): ChatHistoryTurn {
  if (!turn.toolCalls?.length) return turn

  const callCosts = turn.toolCalls.map((call) => estimateTurnToolCallTokens(call))
  let total = estimateTokens(turn.content) + callCosts.reduce((sum, cost) => sum + cost, 0)
  if (total <= budgetTokens) return turn

  const notice = '(result omitted to fit context)'
  const noticeCost = estimateTokens(notice)
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

function compactToolText(text: string): string {
  return text.length <= MAX_MODEL_TOOL_RESULT_CHARS
    ? text
    : text.slice(0, MAX_MODEL_TOOL_RESULT_CHARS)
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN)
}

function lastTurnId(turns: ChatHistoryTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const id = turns[i]?.id
    if (id) return id
  }
  return null
}
