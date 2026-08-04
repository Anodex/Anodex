import { describe, expect, it } from 'vitest'
import type { AgentRun, AgentRunStatus } from '@shared/agentRun.types'
import { selectAwayRuns } from '../useAwayArrivals'

function run(id: string, status: AgentRunStatus): AgentRun {
  return {
    id,
    goal: 'Do the thing',
    status,
    projectId: null,
    enabledTools: [],
    provider: 'local',
    model: null,
    maxTurns: 8,
    turnsUsed: 3,
    flaggedTurns: 0,
    maxTokens: 50_000,
    tokensUsed: 1200,
    maxDurationMinutes: 30,
    activeMs: 0,
    activeSinceAt: null,
    limitsEnabled: true,
    conversationId: null,
    summary: null,
    lastError: null,
    requirePlan: true,
    plan: null,
    createdAt: 0,
    updatedAt: 0
  }
}

const anyRunIsNew = (): boolean => true

describe('selectAwayRuns', () => {
  it('announces nothing for a single landing — that is just a run finishing', () => {
    expect(selectAwayRuns([run('a', 'done')], anyRunIsNew)).toEqual([])
  })

  it('announces a homecoming once two or more runs landed', () => {
    const selected = selectAwayRuns([run('a', 'done'), run('b', 'error')], anyRunIsNew)
    expect(selected.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('counts every terminal status, not just successes', () => {
    const selected = selectAwayRuns(
      [run('a', 'done'), run('b', 'stopped'), run('c', 'error')],
      anyRunIsNew
    )
    expect(selected).toHaveLength(3)
  })

  it('ignores runs that are still going or waiting on a human', () => {
    const selected = selectAwayRuns(
      [run('a', 'running'), run('b', 'needs-review'), run('c', 'done'), run('d', 'done')],
      anyRunIsNew
    )
    expect(selected.map((r) => r.id)).toEqual(['c', 'd'])
  })

  it('drops below the threshold once already-announced runs are excluded', () => {
    // Two terminal runs, but one has already been shown — so this is a single
    // landing, and a band would be announcing something the user has seen.
    const selected = selectAwayRuns([run('a', 'done'), run('b', 'done')], (r) => r.id === 'a')
    expect(selected).toEqual([])
  })

  it('announces nothing for an empty list', () => {
    expect(selectAwayRuns([], anyRunIsNew)).toEqual([])
  })
})
