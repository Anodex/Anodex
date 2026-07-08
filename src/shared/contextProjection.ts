import type { ChatHistoryTurn } from './chat.types'
import type { ConversationContext } from './context.types'
import type { Conversation } from './conversation.types'
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
  /** Approximate projected pressure: system + selected history + reserved response/tool room. */
  usedTokens: number
  pct: number
  systemTokens: number
  historyTokens: number
  reservedTokens: number
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
  systemPrompt
}: {
  conversation: Conversation
  contextSize: number
  systemPrompt?: string
}): ProjectedContextUsage {
  const seeded = seedProjectedHistory(systemPrompt, conversation)
  const reservedTokens = reservedNonHistoryTokens(contextSize)
  const systemTokens = estimateTokens(seeded.systemPrompt ?? '')
  const historyBudget = Math.max(0, contextSize - systemTokens - reservedTokens)
  const split = splitProjectedHistory(seeded.history, historyBudget)
  const historyTokens = split.recent.reduce((sum, turn) => sum + estimateTurnTokens(turn), 0)
  const usedTokens = Math.min(contextSize, systemTokens + historyTokens + reservedTokens)

  return {
    contextSize,
    usedTokens,
    pct: Math.min(100, Math.round((usedTokens / contextSize) * 100)),
    systemTokens,
    historyTokens,
    reservedTokens,
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
  const history = conversation.messages.map(messageToHistoryTurn)
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

  const firstKeptIndex = keepIndices[0] ?? history.length
  return {
    recent: keepIndices.map((i) => history[i]),
    older: history.slice(0, firstKeptIndex)
  }
}

function estimateTurnTokens(turn: ChatHistoryTurn): number {
  let total = estimateTokens(turn.content)
  for (const call of turn.toolCalls ?? []) {
    if (call.status !== 'success' && call.status !== 'error') continue
    total += estimateTokens(compactToolText(call.result ?? call.detail ?? ''))
  }
  return total
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
