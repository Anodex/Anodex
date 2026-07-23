import { create } from 'zustand'
import type {
  CreateScheduledTaskRequest,
  ScheduledTask,
  UpdateScheduledTaskRequest
} from '@shared/scheduledTask.types'
import { anodex } from '../lib/anodex'
import { notifyError, useUiStore } from './uiStore'

interface SchedulerState {
  tasks: ScheduledTask[]
  keepAwake: boolean
  loaded: boolean
  load: () => Promise<void>
  create: (request: CreateScheduledTaskRequest) => Promise<ScheduledTask | null>
  update: (id: string, request: UpdateScheduledTaskRequest) => Promise<void>
  delete: (id: string) => Promise<void>
  runNow: (id: string) => Promise<void>
  setKeepAwake: (value: boolean) => Promise<void>
  /** Called by the IPC bridge when the main process broadcasts a task list change. */
  setTasks: (tasks: ScheduledTask[]) => void
}

/** Mirrors the persisted scheduled-task list from the main process. */
export const useSchedulerStore = create<SchedulerState>((set, get) => ({
  tasks: [],
  keepAwake: false,
  loaded: false,

  load: async () => {
    const [tasks, keepAwake] = await Promise.all([
      anodex.scheduler.list(),
      anodex.scheduler.getKeepAwake()
    ])
    set({ tasks, keepAwake, loaded: true })
  },

  create: async (request) => {
    try {
      const task = await anodex.scheduler.create(request)
      set((state) => ({ tasks: [task, ...state.tasks] }))
      return task
    } catch (error) {
      notifyError('Could not create task', error instanceof Error ? error.message : undefined)
      return null
    }
  },

  update: async (id, request) => {
    try {
      const task = await anodex.scheduler.update(id, request)
      set((state) => ({ tasks: state.tasks.map((t) => (t.id === id ? task : t)) }))
    } catch (error) {
      notifyError('Could not update task', error instanceof Error ? error.message : undefined)
    }
  },

  delete: async (id) => {
    try {
      await anodex.scheduler.delete(id)
      set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) }))
    } catch (error) {
      notifyError('Could not delete task', error instanceof Error ? error.message : undefined)
    }
  },

  runNow: async (id) => {
    const name = get().tasks.find((t) => t.id === id)?.name ?? 'Scheduled task'
    const { notifyPending, resolveToast } = useUiStore.getState()
    const toastId = notifyPending(`Running "${name}"…`)
    try {
      await anodex.scheduler.runNow(id)
      // A run failure inside the task itself (e.g. the agent errored) doesn't
      // reject this promise — SchedulerService catches it, records
      // `lastRunStatus`, and resolves normally. The freshly broadcast task
      // list (updated before this promise resolves) is the real signal.
      const finished = get().tasks.find((t) => t.id === id)
      if (finished?.lastRunStatus === 'error') {
        resolveToast(toastId, {
          kind: 'error',
          title: `"${name}" failed`,
          message: finished.lastRunSummary ?? undefined
        })
      } else if (finished?.lastRunStatus === 'stopped') {
        resolveToast(toastId, {
          kind: 'info',
          title: `"${name}" stopped`,
          message: finished.lastRunSummary ?? undefined
        })
      } else {
        resolveToast(toastId, {
          kind: 'success',
          title: `"${name}" finished`,
          message: finished?.lastRunSummary ?? undefined
        })
      }
    } catch (error) {
      resolveToast(toastId, {
        kind: 'error',
        title: 'Could not run task',
        message: error instanceof Error ? error.message : undefined
      })
    }
  },

  setKeepAwake: async (value) => {
    const applied = await anodex.scheduler.setKeepAwake(value)
    set({ keepAwake: applied })
  },

  setTasks: (tasks) => set({ tasks })
}))
