import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun } from '@shared/agentRun.types'

let userData = ''
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const { discardJournalIfSeriesGone, journalPathFor } = await import('../agentJournal')

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    seriesId: 'series-1',
    goal: 'Keep the changelog up to date',
    status: 'done',
    projectId: 'p1',
    enabledTools: [],
    provider: 'local',
    model: null,
    maxTurns: 8,
    turnsUsed: 1,
    flaggedTurns: 0,
    maxTokens: 100,
    tokensUsed: 10,
    maxDurationMinutes: 60,
    activeMs: 0,
    activeSinceAt: null,
    limitsEnabled: true,
    conversationId: 'c1',
    summary: 'Did a thing.',
    lastError: null,
    ...overrides
  } as AgentRun
}

/** Put a journal on disk for a series, as a finished run would have. */
function writeJournal(seriesId: string): string {
  const path = journalPathFor(seriesId)
  mkdirSync(join(userData, 'agent-series', seriesId), { recursive: true })
  writeFileSync(path, '## 2026-09-23 — done\n\nBought two shares of NOVA.\n', 'utf-8')
  return path
}

/**
 * Deleting a run used to leave its series' journal behind, so userData
 * accumulated the written history of every series the user had ever deleted,
 * with nothing left in the app able to show it again.
 */
describe('discardJournalIfSeriesGone', () => {
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'anodex-journal-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('removes the journal when the last run of the series is gone', () => {
    const path = writeJournal('series-1')
    expect(existsSync(path)).toBe(true)

    discardJournalIfSeriesGone('series-1', [])

    expect(existsSync(path)).toBe(false)
  })

  it('keeps the journal while any run of that series remains', () => {
    const path = writeJournal('series-1')

    // A five-run series with one run deleted still has four readers.
    discardJournalIfSeriesGone('series-1', [
      run({ id: 'run-2', seriesId: 'series-1' }),
      run({ id: 'run-3', seriesId: 'series-1' })
    ])

    expect(existsSync(path)).toBe(true)
  })

  it('leaves other series alone', () => {
    const mine = writeJournal('series-1')
    const theirs = writeJournal('series-2')

    discardJournalIfSeriesGone('series-1', [run({ id: 'run-9', seriesId: 'series-2' })])

    expect(existsSync(mine)).toBe(false)
    expect(existsSync(theirs)).toBe(true)
  })

  it("counts a first run's own id as its series", () => {
    // A series id is absent on a first run; `seriesIdOf` falls back to the id.
    const path = writeJournal('run-solo')

    discardJournalIfSeriesGone('run-solo', [run({ id: 'run-solo', seriesId: undefined })])

    expect(existsSync(path)).toBe(true)
  })

  it('does not throw when there was never a journal', () => {
    expect(() => discardJournalIfSeriesGone('series-never-ran', [])).not.toThrow()
  })
})
