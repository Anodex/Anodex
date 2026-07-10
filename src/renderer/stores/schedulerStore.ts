import { create } from 'zustand'
import type {
  CreateScheduledTaskRequest,
  ScheduledTask,
  UpdateScheduledTaskRequest
} from '@shared/scheduledTask.types'
import { anodex } from '../lib/anodex'
import { notifyError } from './uiStore'

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
export const useSchedulerStore = create<SchedulerState>((set) => ({
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
    try {
      await anodex.scheduler.runNow(id)
    } catch (error) {
      notifyError('Could not run task', error instanceof Error ? error.message : undefined)
    }
  },

  setKeepAwake: async (value) => {
    const applied = await anodex.scheduler.setKeepAwake(value)
    set({ keepAwake: applied })
  },

  setTasks: (tasks) => set({ tasks })
}))
