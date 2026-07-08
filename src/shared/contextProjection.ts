import type { ChatHistoryTurn } from './chat.types'
import type { Conversation } from './conversation.types'
import { MAX_MODEL_TOOL_RESULT_CHARS, reservedNonHistoryTokens } from './contextBudget'
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
  const snapshot = conversation.context?.activeSnapshot
  if (!snapshot?.summary || !snapshot.throughMessageId) {
    return {
      systemPrompt,
      history,
      snapshotTokens: 0,
      snapshotTurns: 0,
      snapshotApplied: false
    }
  }

  const boundaryIndex = history.findIndex((turn) => turn.id === snapshot.throughMessageId)
  if (boundaryIndex < 0) {
    return {
      systemPrompt,
      history,
      snapshotTokens: 0,
      snapshotTurns: 0,
      snapshotApplied: false
    }
  }

  return {
    systemPrompt: buildCompactionSystemPrompt(systemPrompt, snapshot.summary),
    history: history.slice(boundaryIndex + 1),
    snapshotTokens: estimateTokens(snapshot.summary),
    snapshotTurns: snapshot.removedTurns,
    snapshotApplied: true
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
