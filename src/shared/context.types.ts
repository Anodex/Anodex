/**
 * Durable summary of the older part of a conversation.
 *
 * The full chat transcript remains the source of truth for the UI and audit
 * history. A snapshot is only the model-facing shortcut: it lets Anodex skip
 * replaying old turns verbatim while still preserving the facts, decisions,
 * files, and open tasks the model needs for future turns.
 */
export type ContextSnapshotReason = 'onLoad' | 'proactive' | 'reactive' | 'manual'

/**
 * Anodex-owned reason for creating a new Context Ledger revision.
 *
 * This is intentionally separate from the legacy snapshot reason. The old
 * values describe where the compatibility snapshot came from; ledger causes
 * describe why the model-facing representation changed.
 */
export type ContextLedgerCause = 'startup' | 'pressure' | 'recovery' | 'reconciliation' | 'manual'

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

/** A durable Anodex model-context revision, formerly represented by a snapshot. */
export interface ContextLedgerRevision {
  id: string
  createdAt: number
  cause: ContextLedgerCause
  /** Last chat message represented by the continuity digest. */
  throughMessageId: string | null
  /** Number of original turns represented by the digest. */
  coveredTurns: number
  /** Bounded model-facing digest of the covered conversation. */
  continuityDigest: string
}

/**
 * Durable model-context state owned by Anodex.
 *
 * `current` is the active model-facing revision. Future Context Signals and
 * chronological Turn Notes belong here; keeping them optional makes this
 * schema safe for conversations created before the ledger existed.
 */
export interface ContextLedger {
  version: 1
  current: ContextLedgerRevision
  signalFingerprints?: Record<string, string>
  turnNotes?: ContextLedgerTurnNote[]
}

/** A durable model-facing update admitted between provider turns. */
export interface ContextLedgerTurnNote {
  id: string
  createdAt: number
  signalKeys: string[]
  text: string
}

/** Map compatibility snapshot reasons into the Anodex ledger vocabulary. */
export function contextLedgerCauseFromSnapshotReason(
  reason: ContextSnapshotReason
): ContextLedgerCause {
  return reason === 'manual'
    ? 'manual'
    : reason === 'reactive'
      ? 'recovery'
      : reason === 'onLoad'
        ? 'startup'
        : 'pressure'
}

/** Context metadata persisted alongside a conversation. */
export interface ConversationContext {
  /** The active Anodex Context Ledger revision. */
  ledger?: ContextLedger
  /** Compatibility form retained while older conversations and callers migrate. */
  activeSnapshot?: ConversationContextSnapshot
}

/** Translate a legacy snapshot into the Anodex-owned ledger vocabulary. */
export function ledgerRevisionFromSnapshot(
  snapshot: ConversationContextSnapshot
): ContextLedgerRevision {
  return {
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    cause: contextLedgerCauseFromSnapshotReason(snapshot.reason),
    throughMessageId: snapshot.throughMessageId,
    coveredTurns: snapshot.removedTurns,
    continuityDigest: snapshot.summary
  }
}

/** Return the ledger revision while accepting conversations from older builds. */
export function currentLedgerRevision(
  context: ConversationContext | null | undefined
): ContextLedgerRevision | undefined {
  return (
    context?.ledger?.current ??
    (context?.activeSnapshot ? ledgerRevisionFromSnapshot(context.activeSnapshot) : undefined)
  )
}

/**
 * Write the new ledger and its compatibility snapshot together. Keeping both
 * forms synchronized makes the migration reversible and lets older renderer
 * surfaces continue to display compaction markers during rollout.
 */
export function withLedgerRevision(
  context: ConversationContext | null | undefined,
  revision: ContextLedgerRevision
): ConversationContext {
  const previous = context?.ledger
  const reason: ContextSnapshotReason =
    revision.cause === 'manual'
      ? 'manual'
      : revision.cause === 'recovery'
        ? 'reactive'
        : revision.cause === 'startup'
          ? 'onLoad'
          : 'proactive'
  return {
    ...(context ?? {}),
    ledger: {
      version: 1,
      ...(previous ?? {}),
      current: revision
    },
    activeSnapshot: {
      id: revision.id,
      createdAt: revision.createdAt,
      reason,
      throughMessageId: revision.throughMessageId,
      removedTurns: revision.coveredTurns,
      summary: revision.continuityDigest
    }
  }
}
