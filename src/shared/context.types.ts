import type { ContextEpochHandoff } from './chat.types'

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
  /** Immutable locally stored summaries created by each context compaction. */
  compactionHistory?: ConversationContextSnapshot[]
  /** Compatibility form retained while older conversations and callers migrate. */
  activeSnapshot?: ConversationContextSnapshot
  /** Most recent structured recovery handoff, retained for audit and safe resume. */
  latestEpochHandoff?: ContextEpochHandoff
}

/** Retain a bounded recovery record without making it part of evictable history. */
export function withEpochHandoff(
  context: ConversationContext | null | undefined,
  handoff: ContextEpochHandoff
): ConversationContext {
  return { ...(context ?? {}), latestEpochHandoff: handoff }
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
 * All durable compaction summaries in chronological order.
 *
 * Conversations created before revision history existed have no stored list,
 * but their current snapshot is still a real compaction record and should be
 * visible to the user. It is projected into the list here without rewriting
 * the conversation merely because it was opened.
 */
export function contextCompactionHistory(
  context: ConversationContext | null | undefined
): ConversationContextSnapshot[] {
  const history = context?.compactionHistory ?? []
  const active = context?.activeSnapshot
  if (
    !isCompactionSnapshot(active) ||
    history.some(
      (snapshot) =>
        snapshot.id === active.id ||
        (snapshot.throughMessageId === active.throughMessageId &&
          snapshot.removedTurns === active.removedTurns &&
          snapshot.summary === active.summary)
    )
  ) {
    return history
  }
  return [...history, active]
}

/**
 * Combines a live renderer context with the authoritative context returned at
 * generation completion.
 *
 * Compaction notifications can arrive before the final result. Replacing the
 * renderer's state with that result used to lose revisions when the returned
 * context held only its current snapshot. Keep the provider-facing context
 * from `incoming`, but merge the inspection-only local revision history.
 */
export function mergeConversationContext(
  existing: ConversationContext | null | undefined,
  incoming: ConversationContext
): ConversationContext {
  const history = mergeCompactionHistory(
    contextCompactionHistory(existing),
    contextCompactionHistory(incoming)
  )
  return {
    ...incoming,
    ...(history.length > 0 ? { compactionHistory: history } : {})
  }
}

function isCompactionSnapshot(
  snapshot: ConversationContextSnapshot | undefined
): snapshot is ConversationContextSnapshot {
  return Boolean(snapshot && snapshot.removedTurns > 0 && snapshot.summary.trim())
}

function recordsCompaction(cause: ContextLedgerCause): boolean {
  return cause === 'pressure' || cause === 'recovery' || cause === 'manual'
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
  const nextSnapshot: ConversationContextSnapshot = {
    id: revision.id,
    createdAt: revision.createdAt,
    reason,
    throughMessageId: revision.throughMessageId,
    removedTurns: revision.coveredTurns,
    summary: revision.continuityDigest
  }
  const compactionHistory = recordsCompaction(revision.cause)
    ? appendCompactionSnapshot(contextCompactionHistory(context), nextSnapshot)
    : context?.compactionHistory
  return {
    ...(context ?? {}),
    ledger: {
      version: 1,
      ...(previous ?? {}),
      current: revision
    },
    ...(compactionHistory ? { compactionHistory } : {}),
    activeSnapshot: nextSnapshot
  }
}

/**
 * Record one revision per compaction *boundary*, replacing any earlier revision
 * that covered the same one.
 *
 * A stateless transport re-bounds history on every provider round, and every
 * fold mints a fresh revision id — so dropping only the matching id appended a
 * new entry each round. Worse, the boundary cannot advance mid-reply: it is a
 * *message* id, and no new message is persisted until the turn ends. A measured
 * reply therefore produced **151 revisions all naming the same
 * `throughMessageId`**, differing only in a two-turn creep in `removedTurns`,
 * and the user was shown "Context condensed 151 revisions" for what was, in
 * user-visible terms, one compaction.
 *
 * Superseding by boundary keeps the newest and most complete record of each
 * real compaction, which is also what makes an inline transcript marker
 * legible: one marker per place the conversation was actually condensed, rather
 * than a hundred stacked at a single point. Revisions at *different* boundaries
 * still accumulate, because those are genuinely separate events.
 *
 * A snapshot with no boundary (`throughMessageId` null/undefined) cannot be
 * matched this way and falls back to id, so it is never merged with an
 * unrelated one.
 */
function appendCompactionSnapshot(
  snapshots: ConversationContextSnapshot[],
  nextSnapshot: ConversationContextSnapshot
): ConversationContextSnapshot[] {
  const boundary = nextSnapshot.throughMessageId
  const supersedes = (snapshot: ConversationContextSnapshot): boolean =>
    snapshot.id === nextSnapshot.id || (Boolean(boundary) && snapshot.throughMessageId === boundary)
  return [...snapshots.filter((snapshot) => !supersedes(snapshot)), nextSnapshot]
}

function mergeCompactionHistory(
  existing: ConversationContextSnapshot[],
  incoming: ConversationContextSnapshot[]
): ConversationContextSnapshot[] {
  const merged = new Map<string, ConversationContextSnapshot>()
  for (const snapshot of [...existing, ...incoming]) {
    // The live event and final result may use different revision IDs for the
    // same compaction, so the boundary identifies it more reliably than the
    // transport-specific ID. Keyed on the boundary *alone* — deliberately not
    // on `removedTurns`/`summary` too, which is what let one reply's repeated
    // folds against a single boundary survive as 151 separate rows (see
    // `appendCompactionSnapshot`). Later wins, so the row that survives is the
    // most complete account of that boundary.
    const key = snapshot.throughMessageId || `id:${snapshot.id}`
    const previous = merged.get(key)
    if (!previous || snapshot.createdAt >= previous.createdAt) merged.set(key, snapshot)
  }
  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt)
}
