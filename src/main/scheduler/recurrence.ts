import { MIN_INTERVAL_MINUTES, type IntervalUnit, type TaskRecurrence } from '@shared/scheduledTask.types'

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
    return hasRunBefore ? null : nextOccurrenceOfTime(fromMs, recurrence.hour, recurrence.minute)
  }

  if (recurrence.type === 'daily') {
    return nextOccurrenceOfTime(fromMs, recurrence.hour, recurrence.minute)
  }

  if (recurrence.type === 'interval') {
    return fromMs + intervalToMs(recurrence.every ?? MIN_INTERVAL_MINUTES, recurrence.intervalUnit ?? 'minutes')
  }

  const weekdays = recurrence.weekdays ?? []
  if (weekdays.length === 0) return null
  return nextWeekdayOccurrence(fromMs, recurrence.hour, recurrence.minute, weekdays)
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
