/**
 * Durable summary of the older part of a conversation.
 *
 * The full chat transcript remains the source of truth for the UI and audit
 * history. A snapshot is only the model-facing shortcut: it lets Anodex skip
 * replaying old turns verbatim while still preserving the facts, decisions,
 * files, and open tasks the model needs for future turns.
 */
export type ContextSnapshotReason = 'onLoad' | 'proactive' | 'reactive' | 'manual'

export interface ConversationContextSnapshot {
  id: string
  createdAt: number
  reason: ContextSnapshotReason
  /** Last chat message represented by this snapshot, or null for legacy/unknown history. */
  throughMessageId: string | null
  /** Number of original turns folded into the snapshot. */
  removedTurns: number
  /** Model-facing summary injected before the remaining exact turns. */
  summary: string
}

/** Context metadata persisted alongside a conversation. */
export interface ConversationContext {
  /** The single active epoch snapshot used to seed future model context. */
  activeSnapshot?: ConversationContextSnapshot
}
