import { describe, expect, it } from 'vitest'
import type { AgentRun } from '@shared/agentRun.types'
import { normalizeAgentRun } from '../AgentRunStore'

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
    maxTokens: 50_000,
    tokensUsed: 0,
    maxDurationMinutes: 30,
    limitsEnabled: true,
    conversationId: null,
    summary: null,
    lastError: null,
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
})
