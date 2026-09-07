import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `app.getPath('userData')` comes from the environment rather than a shared
 * variable so it survives `vi.resetModules()`: the mock module is rebuilt with
 * every reset, and anything it closed over would be rebuilt with it.
 */
vi.mock('electron', () => ({
  app: { getPath: () => process.env.ANODEX_TEST_USERDATA ?? '' },
  ipcMain: { handle: () => {} }
}))

/**
 * The whole path a phone's `scheduler:list` actually takes.
 *
 * Written because a task existed on a real machine, the file parsed, the store's
 * own mapping returned it, the channel was allowed — and the phone still showed
 * nothing. Every one of those was checked on its own. Isolated checks are how a
 * chain of correct links ends up carrying nothing: the fault is never in the link
 * you already looked at, it is in a join nobody owns.
 *
 * So this exercises the joins. Register the handler the way the app does, find it
 * the way the bridge does, and call it the way a remote client does.
 */
describe('a phone asking for the scheduled tasks', () => {
  /**
   * A virgin copy of every module under test.
   *
   * `schedulerStore` is a singleton holding a parsed cache, and `handlerRegistry`
   * keeps its map at module scope. Shared between cases, the second test would
   * read the first test's tasks and pass on inherited state — which is the exact
   * defect shape this file exists to catch, and it would be embarrassing to ship
   * it in the catcher.
   */
  const freshModules = async () => {
    vi.resetModules()
    return {
      registry: await import('../handlerRegistry'),
      store: (await import('../../scheduler/SchedulerStore')).schedulerStore,
      register: (await import('../../ipc/scheduler.handlers')).registerSchedulerHandlers
    }
  }

  // The scheduler handlers pull in the service, the settings store and the
  // keep-awake shim behind them. On Windows that first cold transform costs more
  // than a default test timeout all by itself, and charging it to whichever case
  // happens to run first makes that case look broken. Pay it once, up front.
  beforeAll(async () => {
    await import('../handlerRegistry')
    await import('../../scheduler/SchedulerStore')
    await import('../../ipc/scheduler.handlers')
  }, 60_000)

  beforeEach(async () => {
    process.env.ANODEX_TEST_USERDATA = await mkdtemp(join(tmpdir(), 'anodex-sched-'))
  })

  const writeTasks = async (tasks: unknown[]): Promise<void> => {
    const dir = join(process.env.ANODEX_TEST_USERDATA!, 'scheduled-tasks')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'tasks.json'), JSON.stringify(tasks), 'utf-8')
  }

  /** The shape the real file holds, including the fields legitimately null. */
  const task = {
    id: 'task_mtkh2v0f_fvnx1',
    name: 'Reminder: meeting with James',
    prompt: 'Remind me about the meeting.',
    projectId: null,
    recurrence: { type: 'once', at: 1788534000000 },
    enabledTools: [],
    enabled: true,
    conversationId: null,
    createdAt: 1788533000000,
    updatedAt: 1788534039500,
    nextRunAt: null,
    lastRunAt: 1788534039500,
    lastRunStatus: 'success',
    lastRunSummary: 'Reminded.',
    runs: [],
    runCount: 1
  }

  it('reaches the same handler the renderer uses and gets the task back', async () => {
    await writeTasks([task])
    const { registry, store, register } = await freshModules()

    registry.captureIpcHandlers()
    register()
    store.init()

    // Found the way the bridge finds it, not by calling the store directly. A
    // handler that registers but is never captured is invisible here, and reaches
    // the phone as a confusing "unknown channel".
    const handler = registry.handlerFor('scheduler:list')
    expect(handler, 'scheduler:list was never captured').toBeDefined()

    // Invoked the way the bridge invokes it: an object standing in for the event,
    // and no arguments after it.
    const result = (await handler!({})) as Array<{ name: string }>

    expect(Array.isArray(result), 'the handler answered with something else').toBe(true)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Reminder: meeting with James')
  })

  it('survives the round trip through JSON that the socket puts it through', async () => {
    // The phone never sees the object this handler returns, only what survives
    // being serialised into a frame. A field that cannot cross that boundary is
    // invisible to every test that inspects the return value directly.
    await writeTasks([task])
    const { registry, store, register } = await freshModules()

    registry.captureIpcHandlers()
    register()
    store.init()

    const result = await registry.handlerFor('scheduler:list')!({})
    const overTheWire = JSON.parse(JSON.stringify({ result })) as {
      result: Array<{ id: string; name: string }>
    }

    expect(overTheWire.result).toHaveLength(1)
    expect(overTheWire.result[0].id).toBe('task_mtkh2v0f_fvnx1')
  })

  it('answers with an empty array, never undefined, when there are no tasks', async () => {
    // A missing result field and an empty list are different answers, and only
    // one of them is a fault. The phone reports them differently now, so the
    // desktop has to keep them distinct too.
    await writeTasks([])
    const { registry, store, register } = await freshModules()

    registry.captureIpcHandlers()
    register()
    store.init()

    const result = await registry.handlerFor('scheduler:list')!({})

    expect(result).toEqual([])
    expect(result).not.toBeUndefined()
  })

  it('answers with an empty list, not an error, when the store was never initialised', async () => {
    // Worth pinning because it is indistinguishable from the truth on the phone:
    // an uninitialised store has no file path, finds nothing, and reports "no
    // tasks" rather than "not ready". `main/index.ts` calls `init()` before
    // `registerIpcHandlers()`, so this is not the live path — but if that order
    // ever changes, the symptom is silence, not a crash.
    await writeTasks([task])
    const { registry, register } = await freshModules()

    registry.captureIpcHandlers()
    register()

    const result = await registry.handlerFor('scheduler:list')!({})

    expect(result).toEqual([])
  })
})
