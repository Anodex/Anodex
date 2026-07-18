import { describe, expect, it } from 'vitest'
import type { AgentRun } from '@shared/agentRun.types'
import { normalizeAgentRun, reconcileInterruptedRuns } from '../AgentRunStore'

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    goal: 'Do the thing',
    status: 'done',
    projectId: null,
    enabledTools: [],
    provider: 'local',
    model: null,
    maxTurns: 8,
    turnsUsed: 0,
    flaggedTurns: 0,
    maxTokens: 50_000,
    tokensUsed: 0,
    maxDurationMinutes: 30,
    limitsEnabled: true,
    conversationId: null,
    summary: null,
    lastError: null,
    requirePlan: true,
    plan: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('normalizeAgentRun', () => {
  it('defaults legacy persisted runs to enforced limits', () => {
    const legacy = makeRun() as Omit<AgentRun, 'limitsEnabled'> & { limitsEnabled?: boolean }
    delete legacy.limitsEnabled

    expect(normalizeAgentRun(legacy).limitsEnabled).toBe(true)
  })

  it('preserves explicit unlimited runs', () => {
    expect(normalizeAgentRun(makeRun({ limitsEnabled: false })).limitsEnabled).toBe(false)
  })

  it('defaults legacy persisted runs to requiring plan review', () => {
    const legacy = makeRun() as Omit<AgentRun, 'requirePlan'> & { requirePlan?: boolean }
    delete legacy.requirePlan

    expect(normalizeAgentRun(legacy).requirePlan).toBe(true)
  })

  it('preserves runs created with plan review off', () => {
    expect(normalizeAgentRun(makeRun({ requirePlan: false })).requirePlan).toBe(false)
  })

  it('defaults legacy persisted runs to no plan', () => {
    const legacy = makeRun() as Omit<AgentRun, 'plan'> & { plan?: AgentRun['plan'] }
    delete legacy.plan

    expect(normalizeAgentRun(legacy).plan).toBeNull()
  })
})

describe('reconcileInterruptedRuns', () => {
  it('marks a run left running as stopped, with a clear reason', () => {
    const [reconciled] = reconcileInterruptedRuns([makeRun({ status: 'running' })])

    expect(reconciled.status).toBe('stopped')
    expect(reconciled.lastError).toBe('Interrupted — the app restarted before this run finished.')
  })

  it('leaves needs-review runs untouched — still safely resumable', () => {
    const run = makeRun({ status: 'needs-review' })
    const [reconciled] = reconcileInterruptedRuns([run])

    expect(reconciled).toBe(run)
  })

  it('leaves already-terminal runs untouched', () => {
    for (const status of ['done', 'stopped', 'error'] as const) {
      const run = makeRun({ status })
      const [reconciled] = reconcileInterruptedRuns([run])
      expect(reconciled).toBe(run)
    }
  })
})
