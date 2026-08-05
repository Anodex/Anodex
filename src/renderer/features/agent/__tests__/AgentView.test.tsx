// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun } from '@shared/agentRun.types'
import { render, screen } from '../../../test-utils/dom'

/**
 * Covers the run card's budget meters, which are the second place a run's time
 * budget is shown. Round four §2 moved that budget onto time actually spent
 * working and updated `AgentRunConversation`'s gauge; this consumer was missed
 * and went on measuring wall clock, so the two views of one run disagreed.
 */

let runs: AgentRun[] = []

vi.mock('../../../stores/agentStore', () => ({
  useAgentStore: (select: (state: unknown) => unknown) =>
    select({
      runs,
      loaded: true,
      stop: vi.fn(),
      delete: vi.fn(),
      approvePlan: vi.fn(),
      rejectPlan: vi.fn()
    })
}))
vi.mock('../../../stores/projectStore', () => ({
  useProjectStore: (select: (state: unknown) => unknown) =>
    select({ projects: [], setActive: vi.fn() })
}))
vi.mock('../../../stores/chatStore', () => ({
  useChatStore: (select: (state: unknown) => unknown) => select({ forkConversation: vi.fn() })
}))
vi.mock('../../../stores/uiStore', () => ({
  useUiStore: (select: (state: unknown) => unknown) => select({ setView: vi.fn(), notify: vi.fn() })
}))
vi.mock('../useAwayArrivals', () => ({
  useAwayArrivals: () => ({
    runs: [],
    dismissed: true,
    sweeping: false,
    spotlightId: null,
    dismiss: vi.fn(),
    orchestrated: () => false
  })
}))
vi.mock('../AgentRunConversation', () => ({ AgentRunConversation: () => null }))
vi.mock('../AgentRunEditor', () => ({ AgentRunEditor: () => null }))

const { AgentView } = await import('../AgentView')

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    goal: 'Summarize the changelog',
    status: 'running',
    projectId: null,
    enabledTools: [],
    provider: 'local',
    model: null,
    maxTurns: 8,
    turnsUsed: 2,
    flaggedTurns: 0,
    maxTokens: 50_000,
    tokensUsed: 1_000,
    maxDurationMinutes: 30,
    activeMs: 0,
    activeSinceAt: null,
    limitsEnabled: true,
    conversationId: null,
    summary: null,
    lastError: null,
    requirePlan: true,
    plan: null,
    createdAt: Date.now() - 90 * 60_000,
    updatedAt: Date.now(),
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  runs = []
})

describe('the run card time meter', () => {
  /**
   * The run was created 90 minutes ago and has worked for 2. Measuring from
   * `createdAt` showed 90 against a 30-minute budget — a meter pinned full over
   * a run that had barely started, disagreeing with the budget that decides
   * when it actually stops.
   */
  it('measures time spent working, not time since the run was created', () => {
    runs = [run({ activeMs: 2 * 60_000 })]

    render(<AgentView />)

    expect(screen.getByText('2/30 min')).toBeDefined()
    expect(screen.queryByText('90/30 min')).toBeNull()
  })

  it('adds the segment currently in flight', () => {
    runs = [run({ activeMs: 60_000, activeSinceAt: Date.now() - 60_000 })]

    render(<AgentView />)

    expect(screen.getByText('2/30 min')).toBeDefined()
  })

  it('shows a run with no limits its raw counts and no ceiling', () => {
    runs = [run({ limitsEnabled: false, activeMs: 5 * 60_000 })]

    render(<AgentView />)

    expect(screen.getByText('5 min')).toBeDefined()
    expect(screen.queryByText(/\/30 min/)).toBeNull()
  })

  it('does not draw budget meters for a run that is not running', () => {
    runs = [run({ status: 'done', activeMs: 2 * 60_000 })]

    render(<AgentView />)

    expect(screen.queryByText('2/30 min')).toBeNull()
  })
})
