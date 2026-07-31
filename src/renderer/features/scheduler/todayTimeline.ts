import { computeNextRunAt } from '@shared/nextRun'
import type { ScheduledTask } from '@shared/scheduledTask.types'

/**
 * What a mark on the day's track represents. The three run statuses are runs
 * that actually happened; `next` and `scheduled` are runs the recurrence says
 * are still coming.
 */
export type TimelineMarkKind = 'success' | 'error' | 'stopped' | 'next' | 'scheduled'

export interface TimelineMark {
  /** Unique per mark, since one task can appear many times in a day. */
  key: string
  taskId: string
  taskName: string
  at: number
  kind: TimelineMarkKind
  /** Where it sits in the day, 0–1. */
  position: number
}

export interface TodayTimeline {
  marks: TimelineMark[]
  /** Where "now" sits in the day, 0–1. */
  nowPosition: number
  completed: number
  failed: number
  upcoming: number
}

/**
 * How far ahead a single task is projected. A five-minute task would otherwise
 * contribute 288 marks to one day and bury every other task on the track. The
 * marks that are drawn are all real scheduled times — the projection just stops
 * early, so nothing false is drawn, there is simply less of it.
 */
const MAX_PROJECTED_PER_TASK = 24

/**
 * The runs a day has already seen and the ones it still expects, as positions
 * on a single 0–1 track.
 *
 * Past marks come from each task's own run history, so they carry what actually
 * happened rather than what was scheduled. Future marks are projected with the
 * same `computeNextRunAt` that schedules them, which means the strip cannot
 * disagree with the scheduler about when a task fires.
 *
 * A paused task contributes nothing ahead of now. It has no `nextRunAt`, and
 * drawing where it *would* have fired would be a claim about a day that isn't
 * happening — though runs it completed before being paused stay, because those
 * did happen.
 */
export function buildTodayTimeline(
  tasks: ScheduledTask[],
  now: number = Date.now()
): TodayTimeline {
  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)
  const dayStart = startOfDay.getTime()
  // Stepping the date rather than adding 24h keeps this correct on the two
  // days a year that aren't 24 hours long.
  const endOfDay = new Date(dayStart)
  endOfDay.setDate(endOfDay.getDate() + 1)
  const dayEnd = endOfDay.getTime()
  const dayLength = dayEnd - dayStart

  const within = (at: number): boolean => at >= dayStart && at < dayEnd
  const position = (at: number): number => (at - dayStart) / dayLength

  const marks: TimelineMark[] = []

  for (const task of tasks) {
    for (const run of task.runs) {
      if (!within(run.startedAt)) continue
      marks.push({
        key: `${task.id}:run:${run.id}`,
        taskId: task.id,
        taskName: task.name,
        at: run.startedAt,
        kind: run.status,
        position: position(run.startedAt)
      })
    }

    if (!task.enabled || task.nextRunAt === null) continue

    let at: number | null = task.nextRunAt
    for (let projected = 0; projected < MAX_PROJECTED_PER_TASK && at !== null; projected++) {
      if (at >= dayEnd) break
      if (at > now) {
        marks.push({
          key: `${task.id}:next:${at}`,
          taskId: task.id,
          taskName: task.name,
          at,
          kind: 'scheduled',
          position: position(at)
        })
      }
      // `hasRunBefore` is true for every projection past the first: a `'once'`
      // task fires exactly once, so this correctly stops it after its one slot
      // instead of repeating it down the rest of the day.
      at = computeNextRunAt(task.recurrence, at, true)
    }
  }

  marks.sort((a, b) => a.at - b.at)

  // The soonest run still ahead is the one the user is actually waiting on.
  const nextMark = marks.find((mark) => mark.kind === 'scheduled')
  if (nextMark) nextMark.kind = 'next'

  return {
    marks,
    nowPosition: Math.min(1, Math.max(0, position(now))),
    completed: marks.filter((mark) => mark.kind === 'success').length,
    failed: marks.filter((mark) => mark.kind === 'error' || mark.kind === 'stopped').length,
    upcoming: marks.filter((mark) => mark.kind === 'next' || mark.kind === 'scheduled').length
  }
}
