import { describe, expect, it } from 'vitest'
import {
  contextLedgerCauseFromSnapshotReason,
  contextCompactionHistory,
  currentLedgerRevision,
  mergeConversationContext,
  withLedgerRevision,
  type ConversationContextSnapshot
} from '../context.types'

const legacySnapshot: ConversationContextSnapshot = {
  id: 'snapshot-1',
  createdAt: 100,
  reason: 'reactive',
  throughMessageId: 'message-4',
  removedTurns: 4,
  summary: 'The project is using the new parser.'
}

describe('Context Ledger compatibility', () => {
  it('maps legacy snapshot causes into Anodex ledger causes', () => {
    expect(contextLedgerCauseFromSnapshotReason('onLoad')).toBe('startup')
    expect(contextLedgerCauseFromSnapshotReason('proactive')).toBe('pressure')
    expect(contextLedgerCauseFromSnapshotReason('reactive')).toBe('recovery')
    expect(contextLedgerCauseFromSnapshotReason('manual')).toBe('manual')
  })

  it('reads an older snapshot as the current ledger revision', () => {
    expect(currentLedgerRevision({ activeSnapshot: legacySnapshot })).toEqual({
      id: 'snapshot-1',
      createdAt: 100,
      cause: 'recovery',
      throughMessageId: 'message-4',
      coveredTurns: 4,
      continuityDigest: 'The project is using the new parser.'
    })
  })

  it('prefers the ledger when both formats exist', () => {
    const context = withLedgerRevision(
      { activeSnapshot: legacySnapshot },
      {
        id: 'ledger-2',
        createdAt: 200,
        cause: 'pressure',
        throughMessageId: 'message-8',
        coveredTurns: 8,
        continuityDigest: 'The parser now has streaming support.'
      }
    )

    expect(currentLedgerRevision(context)?.id).toBe('ledger-2')
    expect(context.activeSnapshot?.id).toBe('ledger-2')
    expect(context.activeSnapshot?.reason).toBe('proactive')
    expect(contextCompactionHistory(context).map((snapshot) => snapshot.id)).toEqual([
      'snapshot-1',
      'ledger-2'
    ])
  })

  it('preserves future ledger metadata while advancing the current revision', () => {
    const context = withLedgerRevision(
      {
        ledger: {
          version: 1,
          current: {
            id: 'ledger-1',
            createdAt: 100,
            cause: 'startup',
            throughMessageId: null,
            coveredTurns: 0,
            continuityDigest: ''
          },
          signalFingerprints: { workspace: 'hash-1' },
          turnNotes: [{ id: 'note-1', createdAt: 100, signalKeys: ['workspace'], text: 'Started.' }]
        }
      },
      {
        id: 'ledger-2',
        createdAt: 200,
        cause: 'manual',
        throughMessageId: 'message-2',
        coveredTurns: 2,
        continuityDigest: 'Two turns were condensed.'
      }
    )

    expect(context.ledger?.signalFingerprints).toEqual({ workspace: 'hash-1' })
    expect(context.ledger?.turnNotes).toHaveLength(1)
    expect(context.ledger?.current.id).toBe('ledger-2')
    expect(context.activeSnapshot?.reason).toBe('manual')
    expect(contextCompactionHistory(context)).toHaveLength(1)
  })

  it('projects a pre-history active compaction into the visible revision list', () => {
    expect(contextCompactionHistory({ activeSnapshot: legacySnapshot })).toEqual([legacySnapshot])
  })

  it('does not add startup reconciliation to compaction history', () => {
    const context = withLedgerRevision(undefined, {
      id: 'ledger-startup',
      createdAt: 100,
      cause: 'startup',
      throughMessageId: null,
      coveredTurns: 0,
      continuityDigest: ''
    })

    expect(contextCompactionHistory(context)).toEqual([])
  })

  it('does not show a signal-only revision as a second compaction', () => {
    const compacted = withLedgerRevision(undefined, {
      id: 'ledger-compaction',
      createdAt: 100,
      cause: 'pressure',
      throughMessageId: 'message-4',
      coveredTurns: 4,
      continuityDigest: 'The first four turns were condensed.'
    })
    const reconciled = withLedgerRevision(compacted, {
      id: 'ledger-signal-refresh',
      createdAt: 200,
      cause: 'reconciliation',
      throughMessageId: 'message-4',
      coveredTurns: 4,
      continuityDigest: 'The first four turns were condensed.'
    })

    expect(contextCompactionHistory(reconciled).map((snapshot) => snapshot.id)).toEqual([
      'ledger-compaction'
    ])
  })

  it('keeps live revisions when the final result only carries its active snapshot', () => {
    const live = withLedgerRevision(
      { activeSnapshot: legacySnapshot },
      {
        id: 'renderer-event',
        createdAt: 200,
        cause: 'pressure',
        throughMessageId: 'message-8',
        coveredTurns: 8,
        continuityDigest: 'The parser now supports streaming.'
      }
    )
    const finalContext = {
      ledger: {
        version: 1 as const,
        current: {
          id: 'main-result',
          createdAt: 201,
          cause: 'pressure' as const,
          throughMessageId: 'message-8',
          coveredTurns: 8,
          continuityDigest: 'The parser now supports streaming.'
        }
      },
      activeSnapshot: {
        id: 'main-result',
        createdAt: 201,
        reason: 'proactive' as const,
        throughMessageId: 'message-8',
        removedTurns: 8,
        summary: 'The parser now supports streaming.'
      }
    }

    const merged = mergeConversationContext(live, finalContext)

    expect(merged.activeSnapshot?.id).toBe('main-result')
    expect(contextCompactionHistory(merged).map((snapshot) => snapshot.id)).toEqual([
      'snapshot-1',
      'main-result'
    ])
  })
})
