import { describe, expect, it, vi } from 'vitest'
import type { AgentRun } from '@shared/agentRun.types'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const { renderJournalEntry } = await import('../agentJournal')

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    seriesId: 'series-1',
    goal: 'Grow a $50 paper portfolio and track the picks',
    status: 'done',
    projectId: 'p1',
    enabledTools: [],
    provider: 'local',
    model: null,
    maxTurns: 8,
    turnsUsed: 3,
    flaggedTurns: 0,
    maxTokens: 100,
    tokensUsed: 10,
    maxDurationMinutes: 60,
    activeMs: 0,
    activeSinceAt: null,
    limitsEnabled: true,
    conversationId: 'c1',
    summary: 'Bought 1 share of X at $20. Cash left: $30.',
    lastError: null,
    ...overrides
  } as AgentRun
}

/**
 * The journal is what the next run reads instead of starting over, so every
 * case here is about a later run being able to act on it correctly.
 */
describe('renderJournalEntry', () => {
  const at = new Date('2026-09-21T14:05:00Z')

  it('states the outcome rather than leaving it to the summary’s tone', () => {
    // "stopped" and "done" read almost identically in prose, and the next run
    // needs to know which happened.
    const entry = renderJournalEntry(run({ status: 'stopped' }), at)
    expect(entry).toContain('2026-09-21 14:05 — stopped')
  })

  it('carries the summary, which is the part with the state in it', () => {
    expect(renderJournalEntry(run(), at)).toContain('Bought 1 share of X at $20')
  })

  it('says so when a run reported nothing, instead of leaving a blank', () => {
    // A gap here reads as "nothing happened", which is a different claim.
    const entry = renderJournalEntry(run({ summary: null }), at)
    expect(entry).toMatch(/no summary/i)
  })

  it('treats an empty summary the same as a missing one', () => {
    expect(renderJournalEntry(run({ summary: '   ' }), at)).toMatch(/no summary/i)
  })

  it('warns the next run when this one claimed things that did not happen', () => {
    // The one case where the summary below should not be taken at face value.
    const entry = renderJournalEntry(run({ flaggedTurns: 2 }), at)
    expect(entry).toMatch(/2 turn\(s\) claimed an outcome that did not happen/)
    expect(entry).toMatch(/suspicion/i)
  })

  it('says nothing about flagged turns when there were none', () => {
    expect(renderJournalEntry(run(), at)).not.toMatch(/did not happen/)
  })

  it('records a failure, which is the entry worth having most', () => {
    const entry = renderJournalEntry(
      run({ status: 'error', summary: null, lastError: 'the market data tool timed out' }),
      at
    )
    expect(entry).toContain('error')
    expect(entry).toContain('the market data tool timed out')
  })

  it('appends rather than replaces, so a series reads in order', () => {
    // Each entry is a self-contained section; concatenating two must produce
    // a document, not a collision.
    const first = renderJournalEntry(run({ summary: 'first' }), at)
    const second = renderJournalEntry(run({ summary: 'second' }), new Date('2026-09-22T09:00:00Z'))
    const combined = first + second
    expect(combined.indexOf('first')).toBeLessThan(combined.indexOf('second'))
    expect(combined.match(/^## /gm)).toHaveLength(2)
  })
})
