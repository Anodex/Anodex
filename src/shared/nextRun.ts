import { MIN_INTERVAL_MINUTES, type IntervalUnit, type TaskRecurrence } from './scheduledTask.types'

/**
 * Recurrence math for scheduled tasks. Pure date arithmetic with no Electron
 * or Node dependency, so it lives in `shared` rather than under the main
 * process: `SchedulerStore` uses it to decide when a task actually fires, and
 * the editor uses the same function to preview when it *would* fire, which
 * means the preview can't disagree with the schedule it's previewing.
 */

/**
 * The next time `recurrence` should fire strictly after `fromMs`, or `null`
 * if it will never fire again — a `'once'` task that has already run, or a
 * `'weekly'` recurrence with no weekdays selected.
 */
export function computeNextRunAt(
  recurrence: TaskRecurrence,
  fromMs: number,
  hasRunBefore: boolean
): number | null {
  if (recurrence.type === 'once') {
    if (hasRunBefore) return null
    // A relative reminder ("in 10 minutes") already resolved to an instant when
    // it was parsed, so it fires at exactly that instant rather than at the
    // next time the clock happens to read some hour:minute.
    if (recurrence.runAt !== undefined) return recurrence.runAt
    return nextOccurrenceOfTime(fromMs, recurrence.hour, recurrence.minute)
  }

  if (recurrence.type === 'daily') {
    return nextOccurrenceOfTime(fromMs, recurrence.hour, recurrence.minute)
  }

  if (recurrence.type === 'interval') {
    const period = intervalToMs(
      recurrence.every ?? MIN_INTERVAL_MINUTES,
      recurrence.intervalUnit ?? 'minutes'
    )
    return recurrence.anchorAt === undefined
      ? fromMs + period
      : nextSlotOnGrid(recurrence.anchorAt, period, fromMs)
  }

  const weekdays = recurrence.weekdays ?? []
  if (weekdays.length === 0) return null
  return nextWeekdayOccurrence(fromMs, recurrence.hour, recurrence.minute, weekdays)
}

/**
 * The first slot on the `anchorAt + n * period` grid strictly after `fromMs`.
 *
 * `fromMs` is the moment the *previous run finished*, so chaining `fromMs +
 * period` instead would fold each run's own duration into the gap: a 30-minute
 * task whose runs take 10 minutes would settle into 40-minute spacing, then
 * drift further every cycle. Anchoring to a fixed grid keeps "every 30
 * minutes" landing on :00 and :30 no matter how long any single run took.
 *
 * Slots missed entirely — because a run overran them, or the app was closed —
 * are skipped rather than replayed, so reopening Anodex after a week doesn't
 * fire a backlog of catch-up runs.
 */
function nextSlotOnGrid(anchorAt: number, period: number, fromMs: number): number {
  // The anchor is a start time, not just a grid origin: the grid runs forward
  // from it, never back. Without this an anchor set ahead of now would resolve
  // to a slot *before* the task was meant to start.
  if (fromMs < anchorAt) return anchorAt
  const elapsedSlots = Math.floor((fromMs - anchorAt) / period)
  return anchorAt + (elapsedSlots + 1) * period
}

/**
 * How many whole `'interval'` slots sit strictly between two consecutive
 * scheduled times — i.e. slots the schedule passed over without running.
 *
 * Normally 0: one run leads to the very next slot. It goes above 0 when a run
 * overran its own cadence or the app was closed across several slots, and
 * those runs genuinely never happened. Always 0 for recurrences that aren't a
 * fixed-period grid, where "a missed slot" has no meaning.
 */
export function slotsBetween(
  recurrence: TaskRecurrence,
  previousRunAt: number | null,
  nextRunAt: number | null
): number {
  if (recurrence.type !== 'interval') return 0
  if (previousRunAt === null || nextRunAt === null) return 0
  const period = intervalToMs(
    recurrence.every ?? MIN_INTERVAL_MINUTES,
    recurrence.intervalUnit ?? 'minutes'
  )
  return Math.max(0, Math.round((nextRunAt - previousRunAt) / period) - 1)
}

/** Converts an interval to milliseconds, clamped to `MIN_INTERVAL_MINUTES`. */
function intervalToMs(every: number, unit: IntervalUnit): number {
  const rawMinutes = unit === 'minutes' ? every : unit === 'hours' ? every * 60 : every * 60 * 24
  return Math.max(rawMinutes, MIN_INTERVAL_MINUTES) * 60_000
}

/** The next timestamp after `fromMs` landing on `hour`:`minute`, today or tomorrow. */
function nextOccurrenceOfTime(fromMs: number, hour: number, minute: number): number {
  const candidate = new Date(fromMs)
  candidate.setHours(hour, minute, 0, 0)
  if (candidate.getTime() <= fromMs) candidate.setDate(candidate.getDate() + 1)
  return candidate.getTime()
}

/**
 * The next timestamp after `fromMs` landing on `hour`:`minute` on one of
 * `weekdays` (0=Sunday..6=Saturday). Scans up to 7 days ahead, which always
 * finds a match for a non-empty `weekdays` even when today's own slot has
 * already passed.
 */
function nextWeekdayOccurrence(
  fromMs: number,
  hour: number,
  minute: number,
  weekdays: number[]
): number {
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(fromMs)
    candidate.setDate(candidate.getDate() + offset)
    candidate.setHours(hour, minute, 0, 0)
    if (candidate.getTime() > fromMs && weekdays.includes(candidate.getDay())) {
      return candidate.getTime()
    }
  }
  // Unreachable: an offset-7 candidate always lands on the same weekday as
  // `fromMs`, so a non-empty `weekdays` (guarded by the caller) always matches
  // within one pass.
  throw new Error('No matching weekday in recurrence')
}
