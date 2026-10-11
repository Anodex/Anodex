import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '@shared/scheduledTask.types'
import type { RecordRunOptions } from '../SchedulerStore'

const mocks = vi.hoisted(() => ({
  tasks: [] as ScheduledTask[],
  recorded: [] as Array<{ taskId: string; options: RecordRunOptions }>,
  toasts: [] as Array<{ title: string; body: string }>,
  ran: 0
}))

vi.mock('../SchedulerStore', () => ({
  schedulerStore: {
    get: (id: string) => mocks.tasks.find((task) => task.id === id),
    list: () => mocks.tasks,
    recordRun: (taskId: string, options: RecordRunOptions) => {
      mocks.recorded.push({ taskId, options })
      return undefined
    }
  }
}))
vi.mock('../../toastWindow', () => ({
  showToastWindow: (content: { title: string; body: string }) => mocks.toasts.push(content)
}))
vi.mock('../../broadcast', () => ({ broadcastToWindows: vi.fn() }))
vi.mock('../../chat/boundedChatRunner', () => ({
  runBoundedChatGeneration: () => {
    mocks.ran += 1
    return Promise.reject(new Error('a reminder must never start a model run'))
  }
}))
vi.mock('../../llama/LlamaService', () => ({
  // A reply is generating the whole time: an ordinary task would wait for it.
  llamaService: {
    isGenerating: () => true,
    summarizeForToast: () => Promise.reject(new Error('no'))
  }
}))

const { schedulerService } = await import('../SchedulerService')

function reminder(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'rem-1',
    name: 'Call Sam',
    prompt: 'Call Sam',
    projectId: null,
    recurrence: { type: 'once', hour: 15, minute: 0 },
    enabledTools: [],
    enabled: true,
    conversationId: null,
    kind: 'reminder',
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: Date.now() - 1000,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunSummary: null,
    runs: [],
    runCount: 0,
    ...overrides
  }
}

const tick = (): Promise<void> => (schedulerService as unknown as { tick(): Promise<void> }).tick()

beforeEach(() => {
  mocks.tasks = []
  mocks.recorded.length = 0
  mocks.toasts.length = 0
  mocks.ran = 0
})

describe('reminders', () => {
  it('fire on time even while a reply is generating, and run no model', async () => {
    mocks.tasks = [reminder()]
    await tick()

    expect(mocks.toasts).toEqual([expect.objectContaining({ title: 'Call Sam', body: 'Reminder' })])
    expect(mocks.recorded).toHaveLength(1)
    expect(mocks.recorded[0].taskId).toBe('rem-1')
    expect(mocks.recorded[0].options).toMatchObject({ status: 'success', conversationId: null })
    expect(mocks.ran).toBe(0)
  })

  it('leave an ordinary task waiting for the reply, as before', async () => {
    mocks.tasks = [
      reminder(),
      reminder({ id: 'task-2', kind: undefined, prompt: 'Summarize mail.' })
    ]
    await tick()

    expect(mocks.recorded.map((entry) => entry.taskId)).toEqual(['rem-1'])
    expect(mocks.ran).toBe(0)
  })

  it('show at once when run by hand', async () => {
    mocks.tasks = [reminder({ nextRunAt: Date.now() + 3_600_000 })]
    await schedulerService.runNow('rem-1')
    expect(mocks.toasts).toHaveLength(1)
  })

  it('stay quiet when disabled or not yet due', async () => {
    mocks.tasks = [
      reminder({ enabled: false }),
      reminder({ id: 'later', nextRunAt: Date.now() + 60_000 })
    ]
    await tick()
    expect(mocks.toasts).toHaveLength(0)
  })
})
