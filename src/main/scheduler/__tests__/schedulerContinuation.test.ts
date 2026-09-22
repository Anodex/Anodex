import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun, CreateAgentRunRequest } from '@shared/agentRun.types'
import type { ScheduledTask } from '@shared/scheduledTask.types'
import type { RecordRunOptions } from '../SchedulerStore'

/**
 * A schedule that advances an agent series instead of running a chat turn.
 *
 * This is the feature that makes the Agent workbench keep going on its own,
 * which means it is also the feature that could keep going when it should not.
 * The cases worth pinning are all of that second kind: the series already
 * working, the series whose runs were deleted, the machine already busy with
 * another run. In each of them the wrong answer is "start another run anyway",
 * and each of them is what an unattended loop meets eventually.
 */

const mocks = vi.hoisted(() => ({
  recorded: [] as Array<{ taskId: string; options: RecordRunOptions }>,
  updated: [] as Array<{ taskId: string; patch: Record<string, unknown> }>,
  started: [] as CreateAgentRunRequest[],
  runs: [] as AgentRun[],
  /** Thrown by the next `agentRunService.start`, standing in for a busy app. */
  startError: null as Error | null,
  /** What `localEngineReady` reports: null when the engine is ready. */
  engineProblem: null as string | null,
  seriesId: undefined as string | undefined
}))

vi.mock('../SchedulerStore', () => ({
  schedulerStore: {
    get: (id: string) => (id === 'task-1' ? task() : undefined),
    list: () => [task()],
    recordRun: (taskId: string, options: RecordRunOptions) => {
      mocks.recorded.push({ taskId, options })
      return undefined
    },
    update: (taskId: string, patch: Record<string, unknown>) => {
      mocks.updated.push({ taskId, patch })
      return undefined
    }
  }
}))

vi.mock('../../agents/AgentRunStore', () => ({
  agentRunStore: { list: () => mocks.runs }
}))

vi.mock('../../llama/localEngineReady', () => ({
  localEngineReady: () => Promise.resolve(mocks.engineProblem)
}))

vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: { get: () => ({ agents: { subAgentProviders: [] } }) }
}))

vi.mock('../../agents/AgentRunService', () => ({
  agentRunService: {
    start: (request: CreateAgentRunRequest) => {
      if (mocks.startError) throw mocks.startError
      mocks.started.push(request)
      return Promise.resolve({ id: 'run_new', ...request })
    }
  }
}))

// Everything the chat path needs, so importing the service does not drag in
// the world. A continuation never reaches any of it — which is itself worth
// asserting, and is asserted below.
vi.mock('../../conversations/ConversationStore', () => ({
  conversationStore: { get: () => undefined, save: vi.fn() }
}))
vi.mock('../../conversations/backgroundTurn', () => ({ appendBackgroundTurn: vi.fn() }))
const generate = vi.fn<(...args: unknown[]) => Promise<unknown>>()
vi.mock('../../chat/boundedChatRunner', () => ({
  runBoundedChatGeneration: (...args: unknown[]) => generate(...args)
}))
vi.mock('../../toastWindow', () => ({ showToastWindow: vi.fn() }))
vi.mock('../../broadcast', () => ({ broadcastToWindows: vi.fn() }))
vi.mock('../../notify', () => ({ notifyUser: vi.fn(), notifyRemoteClients: vi.fn() }))
vi.mock('../../tools/headlessConfirm', () => ({ headlessConfirm: vi.fn() }))
vi.mock('../../llama/LlamaService', () => ({
  llamaService: { getState: () => ({ contextSize: 8192 }) }
}))
vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const { schedulerService } = await import('../SchedulerService')

function task(): ScheduledTask {
  return {
    id: 'task-1',
    name: 'Keep the changelog current',
    prompt: '',
    projectId: 'p_1',
    recurrence: { type: 'daily', hour: 9, minute: 0 },
    enabledTools: [],
    enabled: true,
    conversationId: null,
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: 1,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunSummary: null,
    runs: [],
    runCount: 0,
    continuesSeriesId: mocks.seriesId
  }
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'series-1',
    seriesId: undefined,
    parentRunId: null,
    delegatedTask: null,
    goal: 'Keep the changelog up to date',
    status: 'done',
    projectId: 'p_1',
    enabledTools: ['read_file', 'write_file'],
    provider: 'local',
    model: null,
    maxTurns: 12,
    turnsUsed: 4,
    flaggedTurns: 0,
    maxTokens: 120_000,
    tokensUsed: 900,
    maxDurationMinutes: 40,
    activeMs: 0,
    activeSinceAt: null,
    limitsEnabled: true,
    conversationId: 'conv_1',
    summary: 'Added the entry.',
    lastError: null,
    requirePlan: false,
    plan: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as AgentRun
}

const lastRecord = () => mocks.recorded.at(-1)?.options

beforeEach(() => {
  mocks.recorded.length = 0
  mocks.updated.length = 0
  mocks.started.length = 0
  mocks.runs = [run()]
  mocks.startError = null
  mocks.engineProblem = null
  mocks.seriesId = 'series-1'
  generate.mockReset()
  schedulerService.init()
})

afterEach(() => {
  schedulerService.stop()
})

describe('a schedule that continues an agent series', () => {
  it('starts the next run of that series, not a chat turn', async () => {
    await schedulerService.runNow('task-1')

    expect(generate).not.toHaveBeenCalled()
    expect(mocks.started).toHaveLength(1)
    expect(mocks.started[0]).toMatchObject({
      goal: 'Keep the changelog up to date',
      continuesSeriesId: 'series-1',
      provider: 'local',
      enabledTools: ['read_file', 'write_file']
    })
  })

  it('records the run it started, so the history says what happened', async () => {
    await schedulerService.runNow('task-1')

    expect(lastRecord()?.status).toBe('success')
    expect(lastRecord()?.summary).toMatch(/run_new/)
  })

  it('returns before the run finishes, rather than holding the scheduler open', async () => {
    // An agent run is minutes to hours. Waiting for it inside the scheduler's
    // single-task lock would stall every other schedule on the machine.
    const started = Date.now()
    await schedulerService.runNow('task-1')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('skips the occurrence when the series is already working', async () => {
    // Not queued. The work recurs, so the next occurrence is a better time
    // than the moment this one finishes — and a backlog of overdue
    // continuations is how an unattended feature runs away.
    mocks.runs = [run({ status: 'running' })]

    await schedulerService.runNow('task-1')

    expect(mocks.started).toHaveLength(0)
    expect(lastRecord()?.status).toBe('stopped')
    expect(lastRecord()?.summary).toMatch(/already running/i)
  })

  it('skips while a run of the series waits for plan review', async () => {
    // A parked run is the work, waiting for a person. Starting another would
    // put two runs on one journal and one workspace.
    mocks.runs = [run({ status: 'needs-review' })]

    await schedulerService.runNow('task-1')

    expect(mocks.started).toHaveLength(0)
  })

  it('disables itself when the work it continues has been deleted', async () => {
    // A schedule with nothing to continue has nothing to do, and should stop
    // asking rather than failing every occurrence forever.
    mocks.runs = []

    await schedulerService.runNow('task-1')

    expect(mocks.updated).toEqual([{ taskId: 'task-1', patch: { enabled: false } }])
    expect(lastRecord()?.status).toBe('error')
    expect(lastRecord()?.summary).toMatch(/no longer exists/i)
  })

  it('misses the occurrence quietly when another run holds the lock', async () => {
    // Ordinary rather than broken: only one agent run happens at a time, and
    // a schedule that lands on a busy moment simply waits for the next one.
    mocks.startError = new Error('Another agent run is currently in progress.')

    await schedulerService.runNow('task-1')

    expect(lastRecord()?.status).toBe('stopped')
    expect(lastRecord()?.summary).toMatch(/currently in progress/i)
  })

  it('waits for the local engine rather than starting a run that cannot generate', async () => {
    // Found by running it. The scheduler's first tick lands about five
    // seconds after launch, while a local model is still minutes from ready —
    // so the run started, died with "No model is loaded", and burned the
    // occurrence. On a daily schedule that is the whole day.
    mocks.engineProblem = 'The local model was still loading, so this was left for the next time.'

    await schedulerService.runNow('task-1')

    expect(mocks.started).toHaveLength(0)
    expect(lastRecord()?.status).toBe('stopped')
    expect(lastRecord()?.summary).toMatch(/still loading/i)
  })

  it('still runs a chat turn for an ordinary task', async () => {
    // The branch must not capture every task — the Scheduler's original job is
    // untouched by this.
    mocks.seriesId = undefined
    generate.mockResolvedValue({
      content: 'Done.',
      stats: { tokens: 1, durationMs: 1, tokensPerSecond: 1 },
      stopped: false
    })

    await schedulerService.runNow('task-1')

    expect(generate).toHaveBeenCalled()
    expect(mocks.started).toHaveLength(0)
  })
})
