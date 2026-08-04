import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@shared/conversation.types'
import type { ScheduledTask } from '@shared/scheduledTask.types'
import type { RunGenerationResult } from '../../chat/runGeneration'
import type { RecordRunOptions } from '../SchedulerStore'

/**
 * `SchedulerService`'s first coverage. It fires tasks on a timer with nobody
 * watching, so what matters here is not the happy path — it is what happens
 * when a step *other than* the model call fails. Every one of these failures
 * used to be silent: the only symptom a person would ever see is their
 * scheduled tasks quietly never running again, or a reply that vanished.
 *
 * The conversation store is a real in-memory map rather than a spy, so the
 * merge that keeps a concurrent edit alive is genuinely exercised instead of
 * asserted against a recorded call.
 */

const mocks = vi.hoisted(() => ({
  conversations: new Map<string, Conversation>(),
  /** Thrown by the next `conversationStore.save` call, then cleared. */
  saveError: null as Error | null,
  recorded: [] as Array<{ taskId: string; options: RecordRunOptions }>,
  toasts: [] as Array<{ title: string; body: string }>,
  /** Thrown by `showToastWindow`, standing in for a window that cannot open. */
  toastError: null as Error | null,
  /** Called while the generation is in flight, so a test can act mid-run. */
  duringRun: null as (() => void) | null,
  result: null as RunGenerationResult | null,
  generationError: null as Error | null
}))

vi.mock('../../conversations/ConversationStore', () => ({
  conversationStore: {
    get: (id: string) => mocks.conversations.get(id),
    listAll: () => [...mocks.conversations.values()],
    save: (conversation: Conversation) => {
      if (mocks.saveError) {
        const error = mocks.saveError
        mocks.saveError = null
        throw error
      }
      mocks.conversations.set(conversation.id, conversation)
    }
  }
}))

vi.mock('../SchedulerStore', () => ({
  schedulerStore: {
    get: (id: string) => (id === task().id ? task() : undefined),
    list: () => [task()],
    recordRun: (taskId: string, options: RecordRunOptions) => {
      mocks.recorded.push({ taskId, options })
      return undefined
    }
  }
}))

vi.mock('../../chat/boundedChatRunner', () => ({
  runBoundedChatGeneration: async () => {
    mocks.duringRun?.()
    await Promise.resolve()
    if (mocks.generationError) throw mocks.generationError
    return mocks.result
  }
}))

vi.mock('../../toastWindow', () => ({
  showToastWindow: (content: { title: string; body: string }) => {
    if (mocks.toastError) throw mocks.toastError
    mocks.toasts.push(content)
  }
}))

vi.mock('../../broadcast', () => ({ broadcastToWindows: vi.fn() }))

vi.mock('../../llama/LlamaService', () => ({
  llamaService: {
    isGenerating: () => false,
    // No local model in a unit run; `summarize` is meant to swallow this and
    // fall back to the generic toast body.
    summarizeForToast: () => Promise.reject(new Error('No model loaded.'))
  }
}))

const { schedulerService } = await import('../SchedulerService')

const CONVERSATION_ID = 'sched_conv_existing'

function task(): ScheduledTask {
  return {
    id: 'task-1',
    name: 'Morning digest',
    prompt: 'Summarize new mail.',
    projectId: null,
    recurrence: { type: 'daily', hour: 9, minute: 0 },
    enabledTools: ['read_file'],
    enabled: true,
    conversationId: CONVERSATION_ID,
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: 1,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunSummary: null,
    runs: [],
    runCount: 0
  }
}

function finishedResult(content: string): RunGenerationResult {
  return {
    content,
    stats: { tokens: 10, durationMs: 100, tokensPerSecond: 100 },
    stopped: false
  }
}

/** The task's conversation, as it exists on "disk" right now. */
function stored(): Conversation {
  const conversation = mocks.conversations.get(CONVERSATION_ID)
  if (!conversation) throw new Error('The task conversation is missing.')
  return conversation
}

beforeEach(() => {
  mocks.conversations.clear()
  mocks.conversations.set(CONVERSATION_ID, {
    id: CONVERSATION_ID,
    projectId: null,
    title: 'Morning digest',
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    origin: 'scheduled'
  })
  mocks.saveError = null
  mocks.recorded.length = 0
  mocks.toasts.length = 0
  mocks.toastError = null
  mocks.duringRun = null
  mocks.generationError = null
  mocks.result = finishedResult('Three new messages.')
  // The service is a module singleton, so a test that quits the app would
  // leave every later test running against a shut-down scheduler. Starting it
  // properly each time is also the only way `stop()` is reversible at all.
  schedulerService.init()
})

afterEach(() => {
  schedulerService.stop()
})

describe('SchedulerService — releasing the run lock', () => {
  it('stays able to run tasks after a conversation write fails', async () => {
    // The conversation is created before the run, and `ConversationStore`
    // rethrows a failed save. That throw used to escape past the `finally`
    // that clears the lock, so `runningTaskId` stayed set for the life of the
    // process: every later tick found "a task is already running", and no
    // scheduled task ever ran again until the app was restarted.
    mocks.conversations.delete(CONVERSATION_ID)
    mocks.saveError = new Error('EACCES: permission denied')

    await schedulerService.runNow('task-1')
    mocks.result = finishedResult('Recovered.')

    await expect(schedulerService.runNow('task-1')).resolves.toBeUndefined()
    expect(mocks.recorded[0].options.status).toBe('error')
    expect(mocks.recorded[1].options.status).toBe('success')
  })

  it('records the failed run so the schedule still advances', async () => {
    // Left unrecorded, `nextRunAt` is never recomputed and the task stays
    // permanently due — retried every 30 seconds, forever.
    mocks.conversations.delete(CONVERSATION_ID)
    mocks.saveError = new Error('EACCES: permission denied')

    await schedulerService.runNow('task-1')

    expect(mocks.recorded).toHaveLength(1)
    expect(mocks.recorded[0].options.summary).toContain('EACCES')
  })
})

describe('SchedulerService — reporting a run cannot fail the run', () => {
  it('keeps the reply when the toast cannot be shown', async () => {
    // Opening a window is the one step here that fails for reasons of its own.
    // When it did, the failure path re-ran as though the *generation* had
    // failed and re-saved the conversation from a snapshot taken before the
    // reply existed — destroying the reply it was announcing.
    mocks.toastError = new Error('Object has been destroyed')

    await schedulerService.runNow('task-1')

    const roles = stored().messages.map((message) => message.role)
    expect(roles).toEqual(['user', 'assistant'])
    expect(stored().messages[1].content).toBe('Three new messages.')
  })

  it('records a successful run once, not twice with the second an error', async () => {
    mocks.toastError = new Error('Object has been destroyed')

    await schedulerService.runNow('task-1')

    // Two records meant `runCount` counted one run as two, the report showed a
    // failure that never happened, and `nextRunAt` advanced twice — silently
    // skipping the task's next slot.
    expect(mocks.recorded).toHaveLength(1)
    expect(mocks.recorded[0].options.status).toBe('success')
  })
})

describe('SchedulerService — a chat that changed while the run worked', () => {
  it('keeps a message the user sent into the task’s chat mid-run', async () => {
    // These are ordinary conversations, reachable from the sidebar and from
    // the run's own toast, and the renderer persists a chat by saving all of
    // it. The run held a snapshot taken minutes earlier and wrote it straight
    // back, so anything typed in between disappeared along with its reply.
    mocks.duringRun = () => {
      const current = stored()
      mocks.conversations.set(CONVERSATION_ID, {
        ...current,
        messages: [
          ...current.messages,
          { id: 'typed', role: 'user', content: 'Also check spam.', createdAt: 1 }
        ]
      })
    }

    await schedulerService.runNow('task-1')

    const contents = stored().messages.map((message) => message.content)
    expect(contents).toContain('Also check spam.')
    expect(contents).toContain('Three new messages.')
  })

  it('keeps a rename made while the run was working', async () => {
    mocks.duringRun = () => {
      mocks.conversations.set(CONVERSATION_ID, { ...stored(), title: 'Renamed by hand' })
    }

    await schedulerService.runNow('task-1')

    expect(stored().title).toBe('Renamed by hand')
  })
})

describe('SchedulerService — quitting mid-run', () => {
  it('does not open a toast once the app is shutting down', async () => {
    // `stop()` aborts the run, which unwinds a tick later — by which point
    // `will-quit` has already called `closeToast()`. A toast opened here is a
    // window created during shutdown with nothing left to close it.
    mocks.duringRun = () => schedulerService.stop()

    await schedulerService.runNow('task-1')

    expect(mocks.toasts).toHaveLength(0)
    // The run itself is still recorded — the outcome is real, only the
    // announcement is pointless.
    expect(mocks.recorded).toHaveLength(1)
  })
})

describe('SchedulerService — a failed generation', () => {
  // Passes against the pre-fix file too: a regression guard for the one path
  // through here that was already right, not evidence of a fix. It is worth
  // holding because restructuring the failure handling above is exactly what
  // would break it.
  it('still shows what was attempted, and records it as an error', async () => {
    mocks.generationError = new Error('No model loaded.')

    await schedulerService.runNow('task-1')

    expect(stored().messages.map((message) => message.role)).toEqual(['user'])
    expect(mocks.recorded[0].options.status).toBe('error')
    expect(mocks.toasts[0].body).toContain('failed to run')
  })
})
