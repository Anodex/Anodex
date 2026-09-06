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

  if (recurrence.type === 'monthly') {
    return nextMonthlyOccurrence(fromMs, recurrence)
  }

  // Weekly, stated rather than left as the fallthrough it used to be. Every
  // other branch returns, so an unhandled `RecurrenceType` reached this line
  // and quietly became a weekly rule; a monthly task firing every week is the
  // kind of wrong that reads perfectly plausible on a task card.
  if (recurrence.type === 'weekly') {
    const weekdays = recurrence.weekdays ?? []
    if (weekdays.length === 0) return null
    return nextWeekdayOccurrence(fromMs, recurrence.hour, recurrence.minute, weekdays)
  }

  // `recurrence.type` is exhausted above, so this is only reachable from a
  // stored task written by a newer build. Never firing is the safe reading of
  // a rule this build cannot evaluate.
  return null
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

/** The last day-of-month in the month `year`/`month` (0-11) names. */
function lastDayOfMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one, and it handles
  // leap Februaries without a leap-year rule of its own.
  return new Date(year, month + 1, 0).getDate()
}

/**
 * The next timestamp after `fromMs` matching a `'monthly'` rule, or null if
 * the rule names nothing that can happen.
 *
 * Two shapes, both real things people say:
 *
 * - `dayOfMonth` — "the 15th of every month". A month with no such day clamps
 *   to its last (see `dayOfMonth`'s doc comment).
 * - `weekOfMonth` + `weekdays[0]` — "the last Friday of the month", where -1
 *   means last. The fifth of a weekday does not exist in every month, so a
 *   `weekOfMonth` of 5 skips the months without one instead of clamping; the
 *   fifth Friday is a specific day, not a loose way of saying the last.
 *
 * Scans forward a month at a time rather than adding 30 days, so the rule
 * cannot drift off its day across February or a 31-day month.
 */
function nextMonthlyOccurrence(fromMs: number, recurrence: TaskRecurrence): number | null {
  const from = new Date(fromMs)
  const { hour, minute } = recurrence

  // 13 covers "this month's slot has passed" plus a full year of skipped
  // months, which is more than a `weekOfMonth` of 5 can ever need.
  for (let ahead = 0; ahead <= 13; ahead++) {
    const cursor = new Date(from.getFullYear(), from.getMonth() + ahead, 1)
    const year = cursor.getFullYear()
    const month = cursor.getMonth()

    let day: number
    if (recurrence.weekOfMonth !== undefined) {
      const weekday = recurrence.weekdays?.[0]
      if (weekday === undefined) return null
      const resolved = dayOfNthWeekday(year, month, weekday, recurrence.weekOfMonth)
      if (resolved === null) continue
      day = resolved
    } else {
      const wanted = recurrence.dayOfMonth
      if (wanted === undefined) return null
      day = Math.min(wanted, lastDayOfMonth(year, month))
    }

    const candidate = new Date(year, month, day, hour, minute, 0, 0).getTime()
    if (candidate > fromMs) return candidate
  }

  return null
}

/**
 * The day-of-month of the `nth` `weekday` in a month, or null when the month
 * has no such occurrence. `nth` is 1-based, or -1 for the last one.
 */
function dayOfNthWeekday(year: number, month: number, weekday: number, nth: number): number | null {
  if (nth === -1) {
    const last = lastDayOfMonth(year, month)
    const lastWeekday = new Date(year, month, last).getDay()
    return last - ((lastWeekday - weekday + 7) % 7)
  }

  const firstWeekday = new Date(year, month, 1).getDay()
  const day = 1 + ((weekday - firstWeekday + 7) % 7) + (nth - 1) * 7
  return day > lastDayOfMonth(year, month) ? null : day
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
