import { describe, expect, it, vi } from 'vitest'
import type { AgentRun } from '@shared/agentRun.types'

/**
 * The journal must never be able to stop a run.
 *
 * Both entry points say so in their comments, and neither did. Each computed
 * its path — which asks Electron where `userData` lives — *above* the try
 * block meant to contain exactly this kind of failure. The read one was the
 * dangerous half: it runs while building a run's very first prompt, so a
 * throw there killed the run before it could do anything at all. Fourteen
 * delegation tests went red at once and the assertion said only "expected []
 * to have length 2", which names the symptom and not the cause.
 *
 * So this test makes the path lookup throw, which is the one thing a unit
 * test can do that the real app almost never will.
 */
vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('userData is unavailable')
    }
  }
}))

const { appendRunToJournal, readJournal } = await import('../agentJournal')

function run(): AgentRun {
  return {
    id: 'run-1',
    seriesId: 'series-1',
    goal: 'Keep the portfolio updated',
    status: 'done',
    projectId: null,
    enabledTools: [],
    provider: 'local',
    model: null,
    maxTurns: 8,
    turnsUsed: 1,
    flaggedTurns: 0,
    maxTokens: 1000,
    tokensUsed: 10,
    maxDurationMinutes: 30,
    activeMs: 0,
    activeSinceAt: null,
    limitsEnabled: true,
    conversationId: null,
    summary: 'Done.',
    lastError: null,
    requirePlan: false,
    plan: null,
    createdAt: 0,
    updatedAt: 0
  }
}

describe('a journal that cannot be reached', () => {
  it('reads as no history rather than throwing', () => {
    // This runs while a run is building its first prompt. A throw here does
    // not degrade continuity, it prevents the run.
    expect(() => readJournal('series-1')).not.toThrow()
    expect(readJournal('series-1')).toBeNull()
  })

  it('swallows a failed write rather than failing the run', () => {
    // The run has already done its work by this point; refusing to finish
    // would lose it to protect a note about it.
    expect(() => appendRunToJournal(run())).not.toThrow()
  })
})
