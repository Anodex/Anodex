import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import type {
  CreateScheduledTaskRequest,
  ScheduledTask,
  ScheduledTaskRunStatus,
  TaskRecurrence,
  TaskRunRecord,
  UpdateScheduledTaskRequest
} from '@shared/scheduledTask.types'
import { computeNextRunAt, slotsBetween } from '@shared/nextRun'
import { createLogger } from '../utils/logger'
import { writeJsonAtomic } from '../utils/atomicWrite'

const log = createLogger('scheduler-store')

/** Oldest runs beyond this are dropped from a task's history, newest first. */
const MAX_RUN_HISTORY = 20

/** A run outcome recorded against a task after `SchedulerService` runs it. */
export interface RecordRunOptions {
  status: ScheduledTaskRunStatus
  summary: string | null
  /**
   * The conversation this run wrote into. Null when the run failed before it
   * had one — a failed conversation write, which is recorded like any other
   * failure so the schedule still advances. The task keeps whichever
   * conversation it already had rather than losing the link to its history.
   */
  conversationId: string | null
  /** The assistant message holding the full reply, or null if the run errored before producing one. */
  messageId: string | null
  /** The user message that opened this run, used to segment the transcript by run. */
  userMessageId: string | null
  /** When the run actually began, used for both duration and lateness. */
  startedAt: number
  /** See `TaskRunRecord.fabricationDetected`'s doc comment. Defaults to false when omitted. */
  fabricationDetected?: boolean
}

/**
 * Gives an `'interval'` recurrence a wall-clock anchor if it doesn't have one.
 * `parseWhen` sets this itself, but a schedule built from the exact controls
 * doesn't, and without it the recurrence silently falls back to the old
 * drifting from-last-finish behaviour.
 */
function withAnchor(recurrence: TaskRecurrence, now: number): TaskRecurrence {
  if (recurrence.type !== 'interval' || recurrence.anchorAt !== undefined) return recurrence
  return { ...recurrence, anchorAt: now }
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
    const recurrence = withAnchor(request.recurrence, now)
    const task: ScheduledTask = {
      id: generateId(),
      name: request.name?.trim() || deriveName(request.prompt),
      prompt: request.prompt.trim(),
      projectId: request.projectId,
      recurrence,
      enabledTools: request.enabledTools,
      enabled: true,
      conversationId: null,
      createdAt: now,
      updatedAt: now,
      nextRunAt: computeNextRunAt(recurrence, now, false),
      lastRunAt: null,
      lastRunStatus: null,
      lastRunSummary: null,
      runs: [],
      runCount: 0
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
    // Saving a changed schedule re-anchors the interval grid to now, so the
    // new cadence starts from when you set it rather than from a stale origin.
    const recurrence = request.recurrence
      ? withAnchor(request.recurrence, Date.now())
      : task.recurrence
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
      nextRunAt: enabled ? computeNextRunAt(recurrence, Date.now(), task.lastRunAt !== null) : null
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
    const nextRunAt = task.enabled ? computeNextRunAt(task.recurrence, now, true) : null
    const run: TaskRunRecord = {
      id: generateId(),
      startedAt: options.startedAt,
      durationMs: Math.max(0, now - options.startedAt),
      status: options.status,
      summary: options.summary,
      messageId: options.messageId,
      userMessageId: options.userMessageId,
      // `nextRunAt` was the slot this run was meant to fill; anything past it
      // is time spent waiting for another task to release the run lock.
      delayedMs: task.nextRunAt === null ? 0 : Math.max(0, options.startedAt - task.nextRunAt),
      skippedSlots: slotsBetween(task.recurrence, task.nextRunAt, nextRunAt),
      fabricationDetected: options.fabricationDetected ?? false
    }
    const next: ScheduledTask = {
      ...task,
      conversationId: options.conversationId ?? task.conversationId,
      lastRunAt: now,
      lastRunStatus: options.status,
      lastRunSummary: options.summary,
      nextRunAt,
      runs: [run, ...task.runs].slice(0, MAX_RUN_HISTORY),
      runCount: task.runCount + 1
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
      // Tasks persisted before `runs` existed have no history array yet, and
      // runs recorded before timing/lateness tracking have none of those
      // fields — default them rather than rendering `undefined` in the report.
      return raw.map((task) => ({
        ...task,
        // Tasks from before `runCount` existed start counting from whatever
        // history they retained — the best lower bound available.
        runCount: task.runCount ?? (task.runs ?? []).length,
        runs: (task.runs ?? []).map((run) => ({
          ...run,
          durationMs: run.durationMs ?? 0,
          userMessageId: run.userMessageId ?? null,
          delayedMs: run.delayedMs ?? 0,
          skippedSlots: run.skippedSlots ?? 0
        }))
      }))
    } catch (error) {
      log.warn('Failed to parse scheduled tasks, starting fresh:', error)
      return []
    }
  }

  private persist(tasks: ScheduledTask[]): void {
    try {
      // Atomic: `loadTasks` treats a parse failure as "starting fresh" and
      // returns nothing, so a truncated write would silently delete every
      // scheduled task - work the user set up to run unattended, which then
      // simply never happens and reports nothing.
      writeJsonAtomic(this.filePath, tasks)
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
