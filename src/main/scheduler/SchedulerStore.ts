import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  CreateScheduledTaskRequest,
  ScheduledTask,
  ScheduledTaskRunStatus,
  TaskRunRecord,
  UpdateScheduledTaskRequest
} from '@shared/scheduledTask.types'
import { createLogger } from '../utils/logger'
import { computeNextRunAt } from './recurrence'

const log = createLogger('scheduler-store')

/** Oldest runs beyond this are dropped from a task's history, newest first. */
const MAX_RUN_HISTORY = 20

/** A run outcome recorded against a task after `SchedulerService` runs it. */
export interface RecordRunOptions {
  status: ScheduledTaskRunStatus
  summary: string | null
  conversationId: string
  /** The assistant message holding the full reply, or null if the run errored before producing one. */
  messageId: string | null
}

/**
 * Persists scheduled tasks in their own `userData/scheduled-tasks/tasks.json`
 * — same singleton-class + single-JSON-file pattern as `ModelReliabilityStore`/
 * `ProjectStore`. Owns all `nextRunAt` bookkeeping (via `computeNextRunAt`) so
 * `SchedulerService` never computes recurrence itself, only reads it.
 */
class SchedulerStore {
  private filePath = ''
  private cache: ScheduledTask[] | null = null

  /** Must be called after `app.whenReady()`. */
  init(): void {
    const dir = join(app.getPath('userData'), 'scheduled-tasks')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, 'tasks.json')
    this.cache = this.load()
    log.info('Initialised at', this.filePath)
  }

  list(): ScheduledTask[] {
    return [...this.ensureCache()]
  }

  get(id: string): ScheduledTask | undefined {
    return this.ensureCache().find((task) => task.id === id)
  }

  create(request: CreateScheduledTaskRequest): ScheduledTask {
    const now = Date.now()
    const task: ScheduledTask = {
      id: generateId(),
      name: request.name?.trim() || deriveName(request.prompt),
      prompt: request.prompt.trim(),
      projectId: request.projectId,
      recurrence: request.recurrence,
      enabledTools: request.enabledTools,
      enabled: true,
      conversationId: null,
      createdAt: now,
      updatedAt: now,
      nextRunAt: computeNextRunAt(request.recurrence, now, false),
      lastRunAt: null,
      lastRunStatus: null,
      lastRunSummary: null,
      runs: []
    }
    const tasks = this.ensureCache()
    tasks.unshift(task)
    this.persist(tasks)
    return task
  }

  update(id: string, request: UpdateScheduledTaskRequest): ScheduledTask {
    const tasks = this.ensureCache()
    const index = tasks.findIndex((task) => task.id === id)
    if (index === -1) throw new Error(`Scheduled task not found: ${id}`)
    const task = tasks[index]
    const recurrence = request.recurrence ?? task.recurrence
    const enabled = request.enabled ?? task.enabled
    const next: ScheduledTask = {
      ...task,
      name: request.name !== undefined ? request.name.trim() || task.name : task.name,
      prompt: request.prompt !== undefined ? request.prompt.trim() : task.prompt,
      projectId: request.projectId !== undefined ? request.projectId : task.projectId,
      recurrence,
      enabledTools: request.enabledTools ?? task.enabledTools,
      enabled,
      updatedAt: Date.now(),
      nextRunAt: enabled
        ? computeNextRunAt(recurrence, Date.now(), task.lastRunAt !== null)
        : null
    }
    tasks[index] = next
    this.persist(tasks)
    return next
  }

  delete(id: string): void {
    const tasks = this.ensureCache().filter((task) => task.id !== id)
    this.persist(tasks)
  }

  /** Record a completed run (added to history), then recompute `nextRunAt` for the next occurrence. */
  recordRun(id: string, options: RecordRunOptions): ScheduledTask | undefined {
    const tasks = this.ensureCache()
    const index = tasks.findIndex((task) => task.id === id)
    if (index === -1) return undefined
    const task = tasks[index]
    const now = Date.now()
    const run: TaskRunRecord = {
      id: generateId(),
      startedAt: now,
      status: options.status,
      summary: options.summary,
      messageId: options.messageId
    }
    const next: ScheduledTask = {
      ...task,
      conversationId: options.conversationId,
      lastRunAt: now,
      lastRunStatus: options.status,
      lastRunSummary: options.summary,
      nextRunAt: task.enabled ? computeNextRunAt(task.recurrence, now, true) : null,
      runs: [run, ...task.runs].slice(0, MAX_RUN_HISTORY)
    }
    tasks[index] = next
    this.persist(tasks)
    return next
  }

  private ensureCache(): ScheduledTask[] {
    if (!this.cache) this.cache = this.load()
    return this.cache
  }

  private load(): ScheduledTask[] {
    if (!existsSync(this.filePath)) return []
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as ScheduledTask[]
      // Tasks persisted before `runs` existed have no history array yet.
      return raw.map((task) => ({ ...task, runs: task.runs ?? [] }))
    } catch (error) {
      log.warn('Failed to parse scheduled tasks, starting fresh:', error)
      return []
    }
  }

  private persist(tasks: ScheduledTask[]): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(tasks, null, 2), 'utf-8')
      this.cache = tasks
    } catch (error) {
      log.error('Failed to persist scheduled tasks:', error)
    }
  }
}

function generateId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/** Fallback name from the prompt's first line when the user didn't give one. */
function deriveName(prompt: string): string {
  const firstLine = prompt.trim().split('\n')[0] ?? ''
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine || 'Untitled task'
}

export const schedulerStore = new SchedulerStore()
