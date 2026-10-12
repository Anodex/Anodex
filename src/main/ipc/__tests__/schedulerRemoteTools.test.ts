import { describe, expect, it, vi } from 'vitest'
import { REMOTE_CLIENT } from '@main/clients/clientRegistry'

const created: unknown[] = []
const updated: unknown[] = []
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    }
  }
}))

vi.mock('@main/scheduler/SchedulerStore', () => ({
  schedulerStore: {
    create: (request: unknown) => {
      created.push(request)
      return request
    },
    update: (_id: string, request: unknown) => {
      updated.push(request)
      return request
    },
    delete: vi.fn(),
    list: () => []
  }
}))

const notifyTasksChanged = vi.fn<() => void>()
vi.mock('@main/scheduler/SchedulerService', () => ({
  schedulerService: { runNow: vi.fn(), notifyTasksChanged: () => notifyTasksChanged() }
}))
vi.mock('@main/scheduler/keepAwake', () => ({ setKeepAwake: vi.fn() }))
vi.mock('@main/settings/SettingsStore', () => ({
  settingsStore: { get: () => ({ scheduler: { keepAwake: false } }), update: vi.fn() }
}))

const { registerSchedulerHandlers } = await import('../scheduler.handlers')

/**
 * A task made from a phone runs with nobody watching, and `headlessConfirm`
 * auto-approves anything non-destructive on the stated grounds that "the tool set
 * was already narrowed to what the user opted in".
 *
 * That sentence is only true while the person choosing the tools is the person at
 * the machine. These cases keep it true.
 */
describe('tools on a task created from a phone', () => {
  registerSchedulerHandlers()

  const remote = { [REMOTE_CLIENT]: {} }
  const task = {
    prompt: 'Tidy the project',
    projectId: null,
    recurrence: { type: 'once' as const, runAt: 0 },
    enabledTools: ['write_file', 'run_command']
  }

  it('drops them, however many were asked for', async () => {
    await handlers.get('scheduler:create')!(remote, task)
    expect((created.at(-1) as { enabledTools: string[] }).enabledTools).toEqual([])
  })

  it('keeps them when the request came from this machine', async () => {
    // The editor at the desk is where a tool set is chosen, and it must still work.
    await handlers.get('scheduler:create')!({}, task)
    expect((created.at(-1) as { enabledTools: string[] }).enabledTools).toEqual([
      'write_file',
      'run_command'
    ])
  })

  it('cannot be granted by editing an existing task either', async () => {
    // Undefined, not empty: a remote rename must leave tools granted at the
    // computer alone rather than quietly stripping them.
    await handlers.get('scheduler:update')!(remote, 'task_1', { enabledTools: ['run_command'] })
    expect((updated.at(-1) as { enabledTools?: string[] }).enabledTools).toBeUndefined()
  })
})

/**
 * The phone adds, edits and deletes tasks through these handlers. The desktop's
 * Scheduler page only redraws when it is told, so a change made from the phone
 * stayed invisible on the computer until the page was reloaded.
 */
describe('a change made through the handlers', () => {
  const remote = { [REMOTE_CLIENT]: {} }
  const task = {
    prompt: 'Water the plants',
    projectId: null,
    recurrence: { type: 'once' as const, runAt: 0 },
    enabledTools: []
  }

  it.each([
    ['an add', () => handlers.get('scheduler:create')!(remote, task)],
    ['an edit', () => handlers.get('scheduler:update')!(remote, 'task-1', { name: 'Plants' })],
    ['a delete', () => handlers.get('scheduler:delete')!(remote, 'task-1')]
  ])('tells every window after %s', async (_label, change) => {
    notifyTasksChanged.mockClear()
    await change()
    expect(notifyTasksChanged).toHaveBeenCalledTimes(1)
  })
})

/**
 * The phone's Scheduler has one box and sends the sentence as typed, with no
 * name and no kind. It was stored as an AI task named with the whole sentence.
 */
describe('a task typed into the phone as one sentence', () => {
  const remote = { [REMOTE_CLIENT]: {} }
  const typed = (prompt: string): Record<string, unknown> => ({
    prompt,
    projectId: null,
    recurrence: { type: 'daily' as const, hour: 18, minute: 0 },
    enabledTools: []
  })

  it('is a reminder named for what to do when it asks to be reminded', async () => {
    await handlers.get('scheduler:create')!(
      remote,
      typed('Every day at 6pm remind me to Water the fern')
    )
    expect(created.at(-1)).toMatchObject({
      name: 'Water the fern',
      prompt: 'Water the fern',
      kind: 'reminder'
    })
  })

  it('stays a task, named without its timing, when it asks for work', async () => {
    await handlers.get('scheduler:create')!(remote, typed('Every weekday at 7am, sweep my mail'))
    expect(created.at(-1)).toMatchObject({
      name: 'Sweep my mail',
      prompt: 'Every weekday at 7am, sweep my mail'
    })
    expect(created.at(-1)).not.toHaveProperty('kind')
  })

  it('is left alone when it was given a name', async () => {
    await handlers.get('scheduler:create')!(remote, {
      ...typed('Every day at 6pm remind me to Water the fern'),
      name: 'Fern'
    })
    expect(created.at(-1)).toMatchObject({ name: 'Fern' })
    expect(created.at(-1)).not.toHaveProperty('kind')
  })
})
