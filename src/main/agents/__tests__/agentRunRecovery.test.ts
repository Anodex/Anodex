import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun } from '@shared/agentRun.types'
import type { Conversation } from '@shared/conversation.types'
import type { Plan } from '@shared/plan.types'

/**
 * What happens to a plan-reviewed run when its execution turn fails.
 *
 * `approvePlan()` only accepts `status: 'needs-review'`, so a run that lands in
 * a terminal `'error'` has stranded its approved plan and the planning turns
 * that paid for it — the generic retry action starts a brand new run. The
 * service therefore sends a failed plan-reviewed run back for approval instead.
 *
 * That recovery used to be scoped to a single error message (the shared local
 * engine already generating). The model lock made that message unreachable, so
 * the branch was dead while every *other* failure still stranded the plan.
 */

const runGeneration = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const update = vi.fn<(id: string, patch: Partial<AgentRun>) => AgentRun>()
const get = vi.fn<(id: string) => AgentRun | undefined>()
const showToastWindow = vi.fn<(...args: unknown[]) => void>()

vi.mock('../../chat/runGeneration', () => ({
  runGeneration: (...args: unknown[]) => runGeneration(...args)
}))

vi.mock('../AgentRunStore', () => ({
  agentRunStore: {
    get: (id: string) => get(id),
    update: (id: string, patch: Partial<AgentRun>) => update(id, patch),
    list: () => [],
    create: vi.fn(),
    remove: vi.fn()
  }
}))

vi.mock('../../conversations/ConversationStore', () => ({
  conversationStore: {
    get: (id: string) => (id === conversation.id ? conversation : undefined),
    listAll: () => [conversation],
    save: vi.fn(),
    list: () => [conversation]
  }
}))

vi.mock('../../broadcast', () => ({ broadcastToWindows: vi.fn() }))
vi.mock('../../toastWindow', () => ({
  showToastWindow: (...args: unknown[]) => showToastWindow(...args)
}))
vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: {
    get: () => ({
      general: { permissionMode: 'ask' },
      generation: { turnTimeLimitMinutes: 0 }
    })
  }
}))
vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const { agentRunService } = await import('../AgentRunService')

const plan: Plan = {
  title: 'Approved plan',
  steps: [{ id: 'step-1', title: 'Do the thing', status: 'pending' }],
  updatedAt: 1
}

let conversation: Conversation

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    goal: 'Do the thing',
    status: 'needs-review',
    projectId: null,
    enabledTools: [],
    provider: 'local',
    model: null,
    maxTurns: 8,
    turnsUsed: 1,
    flaggedTurns: 0,
    maxTokens: 50_000,
    tokensUsed: 0,
    maxDurationMinutes: 30,
    activeMs: 0,
    activeSinceAt: null,
    limitsEnabled: true,
    conversationId: 'conv-1',
    summary: null,
    lastError: null,
    requirePlan: true,
    plan,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

/** Drive `approvePlan` → `runLoop` → `runTurn` and wait for the loop to settle. */
async function approveAndSettle(run: AgentRun): Promise<void> {
  get.mockReturnValue(run)
  update.mockImplementation((_id: string, patch: Partial<AgentRun>) => ({ ...run, ...patch }))
  agentRunService.approvePlan(run.id)
  // `approvePlan` kicks the loop off without awaiting it.
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** The patch the run was left in, ignoring the in-progress bookkeeping updates. */
function finalPatch(): Partial<AgentRun> | undefined {
  const withStatus = update.mock.calls.filter((call) => call[1].status !== undefined)
  return withStatus.at(-1)?.[1]
}

beforeEach(() => {
  conversation = {
    id: 'conv-1',
    projectId: null,
    title: 'Agent run',
    messages: [],
    createdAt: 1,
    updatedAt: 1
  }
  runGeneration.mockReset()
  update.mockReset()
  get.mockReset()
  showToastWindow.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a plan-reviewed run whose execution turn fails', () => {
  it('returns to review with the failure recorded, instead of stranding the plan', async () => {
    runGeneration.mockRejectedValue(new Error('llama-server terminated'))

    await approveAndSettle(makeRun())

    expect(finalPatch()).toMatchObject({
      status: 'needs-review',
      lastError: 'llama-server terminated'
    })
  })

  it('recovers from any cause, not just the one that used to be special-cased', async () => {
    runGeneration.mockRejectedValue(new Error('ENOTFOUND api.anthropic.com'))

    await approveAndSettle(makeRun())

    expect(finalPatch()).toMatchObject({
      status: 'needs-review',
      lastError: 'ENOTFOUND api.anthropic.com'
    })
  })

  it('still fails terminally when the run has no plan to protect', async () => {
    runGeneration.mockRejectedValue(new Error('llama-server terminated'))

    await approveAndSettle(makeRun({ requirePlan: false, plan: null }))

    expect(finalPatch()).toMatchObject({ status: 'error' })
  })
})
