import { computeNextRunAt } from '@shared/nextRun'
import type { ScheduledTask, ScheduledTaskRunStatus } from '@shared/scheduledTask.types'

/** One thing on one day: a run that happened, or one the schedule says is coming. */
export interface MonthEntry {
  key: string
  taskId: string
  name: string
  at: number
  reminder: boolean
  /** What happened, for a run in the past; `upcoming` for one still to come. */
  state: ScheduledTaskRunStatus | 'upcoming'
}

/** A task that happens so often it is listed once above the calendar instead of in every square. */
export interface EveryEntry {
  taskId: string
  name: string
  reminder: boolean
  /** "Every day", "Weekdays", "Every 30 minutes". */
  cadence: string
  /** Time of day, when it has one. */
  hour: number | null
  minute: number | null
}

export interface MonthPlan {
  /** Day of the month (1-based) → what is on it, in time order. Frequent tasks excluded. */
  days: Map<number, MonthEntry[]>
  /** Frequent tasks, shown once above the calendar. */
  every: EveryEntry[]
  /** The same frequent tasks' runs, per day, for the detail of a chosen day. */
  everyByDay: Map<number, MonthEntry[]>
}

/** How many times one task is projected forward, so a five-minute task cannot fill a month. */
const MAX_PROJECTED_PER_TASK = 62

/**
 * "Every day", "Weekdays", or a cadence like "Every 2 hours" — or null for a task
 * infrequent enough to show on the days it falls.
 *
 * Something that happens every day is not news on any one day, and drawn in all
 * thirty squares it buries everything that is. So it is said once, above.
 */
export function frequentCadence(task: ScheduledTask): string | null {
  const r = task.recurrence
  if (r.type === 'daily') return 'Every day'
  if (r.type === 'interval') {
    const every = r.every ?? 1
    const unit = r.intervalUnit ?? 'hours'
    if (unit === 'days' && every > 1) return null
    const word = unit === 'minutes' ? 'minute' : unit === 'hours' ? 'hour' : 'day'
    return every === 1 ? `Every ${word}` : `Every ${every} ${word}s`
  }
  if (r.type === 'weekly') {
    const days = [...new Set(r.weekdays ?? [])].sort()
    if (days.length === 7) return 'Every day'
    if (days.length === 5 && days.join(',') === '1,2,3,4,5') return 'Weekdays'
    if (days.length >= 5) return `${days.length} days a week`
  }
  return null
}

/**
 * What a month holds: each task's past runs as they happened, and its future runs
 * as `computeNextRunAt` will schedule them — the same function the scheduler fires
 * on, so the calendar cannot promise a run the scheduler will not make.
 *
 * A paused task shows its past runs and nothing ahead, as the today strip does.
 */
export function buildMonth(
  tasks: ScheduledTask[],
  year: number,
  month: number,
  now: number = Date.now()
): MonthPlan {
  const start = new Date(year, month, 1).getTime()
  const end = new Date(year, month + 1, 1).getTime()
  const days = new Map<number, MonthEntry[]>()
  const everyByDay = new Map<number, MonthEntry[]>()
  const every: EveryEntry[] = []
  const add = (into: Map<number, MonthEntry[]>, entry: MonthEntry): void => {
    const day = new Date(entry.at).getDate()
    const list = into.get(day) ?? []
    list.push(entry)
    into.set(day, list)
  }

  for (const task of tasks) {
    const cadence = frequentCadence(task)
    const reminder = task.kind === 'reminder'
    const into = cadence ? everyByDay : days
    if (cadence && task.enabled) {
      every.push({
        taskId: task.id,
        name: task.name,
        reminder,
        cadence,
        hour: task.recurrence.type === 'interval' ? null : task.recurrence.hour,
        minute: task.recurrence.type === 'interval' ? null : task.recurrence.minute
      })
    }

    for (const run of task.runs) {
      if (run.startedAt < start || run.startedAt >= end) continue
      add(into, {
        key: `${task.id}:run:${run.id}`,
        taskId: task.id,
        name: task.name,
        at: run.startedAt,
        reminder,
        state: run.status
      })
    }

    if (!task.enabled || task.nextRunAt === null) continue
    let at: number | null = task.nextRunAt
    for (let n = 0; n < MAX_PROJECTED_PER_TASK && at !== null && at < end; n++) {
      if (at >= start && at > now) {
        add(into, {
          key: `${task.id}:next:${at}`,
          taskId: task.id,
          name: task.name,
          at,
          reminder,
          state: 'upcoming'
        })
      }
      // Past the first projection a `'once'` task has run, which stops it after its one slot.
      at = computeNextRunAt(task.recurrence, at, true)
    }
  }

  for (const list of [...days.values(), ...everyByDay.values()]) list.sort((a, b) => a.at - b.at)
  every.sort(
    (a, b) => (a.hour ?? -1) * 60 + (a.minute ?? 0) - ((b.hour ?? -1) * 60 + (b.minute ?? 0))
  )
  return { days, every, everyByDay }
}

/** The month's squares, Monday first: day numbers, with null for the padding either side. */
export function monthGrid(year: number, month: number): Array<number | null> {
  const lead = (new Date(year, month, 1).getDay() + 6) % 7
  const length = new Date(year, month + 1, 0).getDate()
  const cells: Array<number | null> = Array.from({ length: lead }, () => null)
  for (let day = 1; day <= length; day++) cells.push(day)
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}
