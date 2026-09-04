import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask, CreateScheduledTaskRequest } from '@shared/scheduledTask.types'
import { deleteScheduledTaskTool, scheduleTaskTool } from '../schedulerTools'
import { headlessConfirm } from '../headlessConfirm'
import { captureConfirmations, createMockContext, createMockDefine } from './test-helpers'

const createMock = vi.fn<(request: CreateScheduledTaskRequest) => ScheduledTask>()
const notifyMock = vi.fn<() => void>()
const listMock = vi.fn<() => ScheduledTask[]>()
const deleteMock = vi.fn<(id: string) => void>()

vi.mock('../../scheduler/SchedulerStore', () => ({
  schedulerStore: {
    create: (request: CreateScheduledTaskRequest) => createMock(request),
    list: () => listMock(),
    delete: (id: string) => deleteMock(id)
  }
}))

vi.mock('../../scheduler/SchedulerService', () => ({
  schedulerService: { notifyTasksChanged: () => notifyMock() }
}))

type ScheduleArgs = { when: string; prompt: string; name?: string; tools?: string[] }
type ScheduleTool = { handler: (args: ScheduleArgs) => Promise<string> }

function taskFrom(request: CreateScheduledTaskRequest): ScheduledTask {
  return {
    id: 'task-1',
    name: request.name ?? 'Derived name',
    prompt: request.prompt,
    projectId: request.projectId,
    recurrence: request.recurrence,
    enabledTools: request.enabledTools,
    enabled: true,
    conversationId: null,
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: Date.UTC(2026, 6, 25, 18, 0),
    lastRunAt: null,
    lastRunStatus: null,
    lastRunSummary: null,
    runs: [],
    runCount: 0
  }
}

describe('schedule_task', () => {
  beforeEach(() => {
    createMock.mockReset()
    notifyMock.mockReset()
    createMock.mockImplementation(taskFrom)
  })

  it('turns plain language into a recurrence and confirms the resolved schedule', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext('/workspace'), confirm }
    const tool = scheduleTaskTool(createMockDefine(), ctx) as unknown as ScheduleTool

    const result = await tool.handler({
      when: 'every weekday at 9am',
      prompt: 'Summarize new mail in my inbox.'
    })

    expect(requests).toHaveLength(1)
    // "every 5 minutes" and "in 5 minutes" are one word apart, so the prompt
    // must show what was understood, not the phrase that was typed.
    expect(requests[0].detail).toContain('Weekdays at 9:00 AM')
    const request = createMock.mock.calls[0][0]
    expect(request.prompt).toBe('Summarize new mail in my inbox.')
    expect(request.recurrence).toMatchObject({ type: 'weekly', hour: 9, minute: 0 })
    expect(result).toContain('Scheduled')
    expect(notifyMock).toHaveBeenCalledTimes(1)
  })

  it('always asks first, even in untethered mode', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = {
      ...createMockContext('/workspace'),
      permissionMode: 'untethered' as const,
      confirm
    }
    const tool = scheduleTaskTool(createMockDefine(), ctx) as unknown as ScheduleTool

    await tool.handler({ when: 'in 30 minutes', prompt: 'Remind me to push the branch.' })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ toolName: 'schedule_task', risk: 'sensitive' })
  })

  it('creates nothing when the schedule cannot be parsed', async () => {
    const { confirm } = captureConfirmations()
    const ctx = { ...createMockContext('/workspace'), confirm }
    const tool = scheduleTaskTool(createMockDefine(), ctx) as unknown as ScheduleTool

    const result = await tool.handler({ when: 'whenever it feels right', prompt: 'Do a thing.' })

    expect(result).toContain('Error')
    expect(createMock).not.toHaveBeenCalled()
  })

  it('refuses to bake a human-approval-only tool into a task', async () => {
    // Otherwise scheduling the send would route straight around
    // `headlessConfirm` — the run would auto-approve what a live chat cannot.
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext('/workspace'), confirm }
    const tool = scheduleTaskTool(createMockDefine(), ctx) as unknown as ScheduleTool

    await tool.handler({
      when: 'tomorrow at noon',
      prompt: 'Send Gabriel the update.',
      tools: ['send_email', 'draft_email', 'summarize_thread']
    })

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabledTools: ['draft_email', 'summarize_thread'] })
    )
    // The prompt has to say what was dropped rather than quietly granting less.
    expect(requests[0].detail).toContain('send_email')
    expect(requests[0].detail).toContain('needs a person')
  })

  it('drops project-only tools when the chat has no project', async () => {
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext('/workspace'), projectId: null, confirm }
    const tool = scheduleTaskTool(createMockDefine(), ctx) as unknown as ScheduleTool

    await tool.handler({
      when: 'hourly',
      prompt: 'Check the build.',
      tools: ['run_command', 'fetch_url', 'not_a_real_tool']
    })

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabledTools: ['fetch_url'] })
    )
    expect(requests[0].detail).toContain('needs an open project')
    expect(requests[0].detail).toContain('no such tool')
  })

  it('scopes the task to the chat it was created from', async () => {
    const { confirm } = captureConfirmations()
    const ctx = { ...createMockContext('/workspace'), projectId: 'p1', confirm }
    const tool = scheduleTaskTool(createMockDefine(), ctx) as unknown as ScheduleTool

    await tool.handler({ when: 'daily at 6pm', prompt: 'Review open changes.' })

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }))
  })

  it('creates nothing when the user denies the prompt', async () => {
    const ctx = {
      ...createMockContext('/workspace'),
      confirm: () => Promise.resolve({ approved: false, reason: 'wrong time' })
    }
    const tool = scheduleTaskTool(createMockDefine(), ctx) as unknown as ScheduleTool

    const result = await tool.handler({ when: 'daily at 6pm', prompt: 'Review open changes.' })

    expect(result).toContain('wrong time')
    expect(createMock).not.toHaveBeenCalled()
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('can still be used by an unattended run, since scheduling sends nothing', async () => {
    const ctx = {
      ...createMockContext('/workspace'),
      permissionMode: 'untethered' as const,
      confirm: headlessConfirm
    }
    const tool = scheduleTaskTool(createMockDefine(), ctx) as unknown as ScheduleTool

    const result = await tool.handler({ when: 'in 45 minutes', prompt: 'Retry the failed step.' })

    expect(result).toContain('Scheduled')
  })
})

type DeleteTool = { handler: (args: { name: string }) => Promise<string> }

/** A stored task with just the fields the delete path reads. */
function taskNamed(id: string, name: string): ScheduledTask {
  return {
    ...taskFrom({
      prompt: 'p',
      projectId: null,
      recurrence: { type: 'once', runAt: 0 }
    } as CreateScheduledTaskRequest),
    id,
    name
  }
}

describe('delete_scheduled_task', () => {
  beforeEach(() => {
    listMock.mockReset()
    deleteMock.mockReset()
    notifyMock.mockReset()
    listMock.mockReturnValue([
      taskNamed('task-1', 'Interval test'),
      taskNamed('task-2', 'Reminder: meeting with James')
    ])
  })

  it('confirms the task it resolved, not the name the model typed', async () => {
    // The user is approving the removal of standing work. A card that only
    // echoed their words back would confirm nothing about which task goes.
    const { requests, confirm } = captureConfirmations()
    const ctx = { ...createMockContext('/workspace'), confirm }
    const tool = deleteScheduledTaskTool(createMockDefine(), ctx) as unknown as DeleteTool

    const result = await tool.handler({ name: 'interval' })

    expect(requests).toHaveLength(1)
    expect(requests[0].detail).toContain('Interval test')
    expect(deleteMock).toHaveBeenCalledWith('task-1')
    expect(notifyMock).toHaveBeenCalled()
    expect(result).toContain('Deleted "Interval test"')
  })

  it('refuses an ambiguous name instead of picking one', async () => {
    // Deleting the wrong standing task is silent: nothing errors, and the user
    // finds out when the thing it did stops happening.
    listMock.mockReturnValue([taskNamed('a', 'Daily digest'), taskNamed('b', 'Daily standup')])
    const { confirm } = captureConfirmations()
    const ctx = { ...createMockContext('/workspace'), confirm }
    const tool = deleteScheduledTaskTool(createMockDefine(), ctx) as unknown as DeleteTool

    const result = await tool.handler({ name: 'daily' })

    expect(deleteMock).not.toHaveBeenCalled()
    expect(result).toContain('matches 2 tasks')
    expect(result).toContain('Daily digest')
    expect(result).toContain('Daily standup')
  })

  it('prefers an exact name over a longer one containing it', async () => {
    listMock.mockReturnValue([taskNamed('a', 'Test'), taskNamed('b', 'Test run')])
    const { confirm } = captureConfirmations()
    const ctx = { ...createMockContext('/workspace'), confirm }
    const tool = deleteScheduledTaskTool(createMockDefine(), ctx) as unknown as DeleteTool

    await tool.handler({ name: 'Test' })

    expect(deleteMock).toHaveBeenCalledWith('a')
  })

  it('names the existing tasks when nothing matches', async () => {
    const { confirm } = captureConfirmations()
    const ctx = { ...createMockContext('/workspace'), confirm }
    const tool = deleteScheduledTaskTool(createMockDefine(), ctx) as unknown as DeleteTool

    const result = await tool.handler({ name: 'nonexistent' })

    expect(deleteMock).not.toHaveBeenCalled()
    expect(result).toContain('Interval test')
  })

  it('deletes nothing when the user declines', async () => {
    const ctx = {
      ...createMockContext('/workspace'),
      confirm: () => Promise.resolve({ approved: false })
    }
    const tool = deleteScheduledTaskTool(createMockDefine(), ctx) as unknown as DeleteTool

    await tool.handler({ name: 'Interval test' })

    expect(deleteMock).not.toHaveBeenCalled()
  })

  it('cannot delete a task in an unattended run', async () => {
    // The case this exists for is a scheduled task deleting scheduled tasks.
    // `headlessConfirm` refuses destructive work, so an unattended run cannot
    // reach the store however it is prompted.
    const ctx = { ...createMockContext('/workspace'), confirm: headlessConfirm }
    const tool = deleteScheduledTaskTool(createMockDefine(), ctx) as unknown as DeleteTool

    await tool.handler({ name: 'Interval test' })

    expect(deleteMock).not.toHaveBeenCalled()
  })
})
