import {
  currentLedgerRevision,
  withLedgerRevision,
  type ContextLedgerRevision,
  type ConversationContext
} from './context.types'

export type ContextSignalValues = Record<string, string | null | undefined>

export interface ContextSignalReconciliation {
  context: ConversationContext
  changedKeys: string[]
  changed: boolean
}

/** Small deterministic fingerprint for local, non-secret context metadata. */
function fingerprint(value: string): string {
  let hash = 2_166_136_261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Reconcile stable prompt inputs only at the boundary before a provider turn.
 * A changed signal advances the ledger revision without pretending that a new
 * transcript summary was created; the existing digest and message boundary
 * remain valid, while a short note records why the model-facing epoch changed.
 */
export function reconcileContextSignals(
  context: ConversationContext | null | undefined,
  signals: ContextSignalValues,
  createdAt: number,
  revisionId: string
): ContextSignalReconciliation {
  // Do not rewrite a legacy snapshot merely because a newer reader is
  // inspecting it. The next compaction or explicit context update will write
  // the ledger projection; until then, preserving the exact object keeps old
  // callers and renderer markers stable.
  if (context?.activeSnapshot && !context.ledger) {
    return { context, changedKeys: [], changed: false }
  }

  const previousRevision = currentLedgerRevision(context)
  const previousFingerprints = context?.ledger?.signalFingerprints ?? {}
  const nextFingerprints: Record<string, string> = {}
  const changedKeys: string[] = []

  for (const [key, value] of Object.entries(signals).sort(([a], [b]) => a.localeCompare(b))) {
    const next = fingerprint(value ?? '')
    nextFingerprints[key] = next
    if (previousFingerprints[key] !== next) changedKeys.push(key)
  }

  const revision: ContextLedgerRevision = previousRevision ?? {
    id: revisionId,
    createdAt,
    cause: 'startup',
    throughMessageId: null,
    coveredTurns: 0,
    continuityDigest: ''
  }
  const shouldAdvance = previousRevision !== undefined && changedKeys.length > 0
  const nextRevision = shouldAdvance
    ? { ...revision, id: revisionId, createdAt, cause: 'reconciliation' as const }
    : revision
  let nextContext = withLedgerRevision(context, nextRevision)
  nextContext = {
    ...nextContext,
    ledger: {
      ...nextContext.ledger!,
      signalFingerprints: nextFingerprints,
      turnNotes:
        shouldAdvance || !previousRevision
          ? [
              ...(nextContext.ledger?.turnNotes ?? []),
              ...(changedKeys.length > 0
                ? [
                    {
                      id: revisionId,
                      createdAt,
                      signalKeys: changedKeys,
                      text: `Context signals reconciled: ${changedKeys.join(', ')}.`
                    }
                  ]
                : [])
            ].slice(-24)
          : nextContext.ledger?.turnNotes
    }
  }

  return {
    context: nextContext,
    changedKeys,
    changed: !previousRevision || shouldAdvance
  }
}
