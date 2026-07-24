import { MIN_INTERVAL_MINUTES, type IntervalUnit, type TaskRecurrence } from './scheduledTask.types'

/**
 * A successfully parsed schedule, plus the strings the editor shows back so
 * the user can confirm Anodex read them the way they meant it.
 */
export interface ParsedWhen {
  recurrence: TaskRecurrence
  /** Human summary of the rule, e.g. "Every 30 minutes", "Weekdays at 5:00 PM". */
  label: string
  /**
   * Set when the input was accepted but adjusted — currently only when a
   * repeating interval was raised to `MIN_INTERVAL_MINUTES`. Null when the
   * parse was taken literally.
   */
  note: string | null
}

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/**
 * Unit spellings accepted after a number. Deliberately typo-tolerant — this
 * field is meant to be typed the way you'd say it out loud, and "1 mint" is a
 * real thing people type. Anything not listed here fails the parse rather than
 * being guessed at, so a misread never silently schedules the wrong thing.
 */
const UNIT_WORDS: Record<string, IntervalUnit | 'weeks'> = {
  m: 'minutes',
  min: 'minutes',
  mins: 'minutes',
  mint: 'minutes',
  mints: 'minutes',
  minut: 'minutes',
  minute: 'minutes',
  minutes: 'minutes',
  h: 'hours',
  hr: 'hours',
  hrs: 'hours',
  hour: 'hours',
  hours: 'hours',
  d: 'days',
  day: 'days',
  days: 'days',
  w: 'weeks',
  week: 'weeks',
  weeks: 'weeks'
}

const DAY_WORDS: Record<string, number> = {
  sunday: 0,
  sundays: 0,
  sun: 0,
  monday: 1,
  mondays: 1,
  mon: 1,
  tuesday: 2,
  tuesdays: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wednesdays: 3,
  wed: 3,
  thursday: 4,
  thursdays: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fridays: 5,
  fri: 5,
  saturday: 6,
  saturdays: 6,
  sat: 6
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS = [1, 2, 3, 4, 5]
const WEEKEND = [0, 6]
/** Used whenever a rule needs a time of day but the input didn't give one. */
const DEFAULT_HOUR = 9

interface TimeOfDay {
  hour: number
  minute: number
}

/** 24h `hour`/`minute` as a 12h clock string, e.g. "5:00 PM". */
export function formatTimeOfDay(hour: number, minute: number): string {
  const period = hour < 12 ? 'AM' : 'PM'
  const displayHour = hour % 12 === 0 ? 12 : hour % 12
  return `${displayHour}:${String(minute).padStart(2, '0')} ${period}`
}

function pluralize(count: number, unit: string): string {
  return `${count} ${count === 1 ? unit.replace(/s$/, '') : unit}`
}

/** Pulls a time of day out of the text, or null when it doesn't name one. */
function matchTimeOfDay(text: string): TimeOfDay | null {
  if (/\bnoon\b|\bmidday\b/.test(text)) return { hour: 12, minute: 0 }
  if (/\bmidnight\b/.test(text)) return { hour: 0, minute: 0 }

  // "9am", "9:30 pm", "at 5 p.m."
  const meridiem = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/)
  if (meridiem) {
    const rawHour = Number(meridiem[1])
    if (rawHour > 12) return null
    const hour = (rawHour % 12) + (meridiem[3] === 'p' ? 12 : 0)
    return { hour, minute: meridiem[2] ? Number(meridiem[2]) : 0 }
  }

  // 24-hour "at 17:00" / bare "17:00"
  const clock = text.match(/\b(?:at\s+)?(\d{1,2}):(\d{2})\b/)
  if (clock) {
    const hour = Number(clock[1])
    const minute = Number(clock[2])
    if (hour > 23 || minute > 59) return null
    return { hour, minute }
  }

  // Bare hour, but only after "at" — a lone number elsewhere is far more
  // likely to be a count ("every 30 minutes") than an o'clock.
  const bare = text.match(/\bat\s+(\d{1,2})\b/)
  if (bare) {
    const hour = Number(bare[1])
    if (hour > 23) return null
    return { hour, minute: 0 }
  }

  return null
}

/** The first weekday named in the text, or null. */
function matchWeekday(text: string): number | null {
  for (const word of Object.keys(DAY_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) return DAY_WORDS[word]
  }
  return null
}

function toMs(count: number, unit: IntervalUnit | 'weeks'): number {
  if (unit === 'minutes') return count * MINUTE_MS
  if (unit === 'hours') return count * HOUR_MS
  if (unit === 'weeks') return count * 7 * DAY_MS
  return count * DAY_MS
}

/** Collapses `'weeks'` onto the storable units, since `IntervalUnit` has no week. */
function normalizeInterval(
  count: number,
  unit: IntervalUnit | 'weeks'
): { every: number; intervalUnit: IntervalUnit } {
  if (unit === 'weeks') return { every: count * 7, intervalUnit: 'days' }
  return { every: count, intervalUnit: unit }
}

/**
 * Wraps a parsed rule with the label the editor previews. The label always
 * comes from `describeRecurrence`, so the preview under the input and the
 * description on the task card can never word the same schedule differently.
 */
function accept(recurrence: TaskRecurrence, note: string | null = null): ParsedWhen {
  return { recurrence, label: describeRecurrence(recurrence), note }
}

/**
 * Reads a natural-language schedule into a `TaskRecurrence` — "every 30
 * minutes", "in 10 minutes", "weekdays at 5pm", "every Friday at 4pm".
 *
 * Returns null when nothing in the text names a time, which the editor shows
 * as a hint rather than guessing: silently scheduling something for a time the
 * user didn't ask for is exactly the failure this field exists to fix.
 *
 * `now` is injectable so the relative forms ("in 10 minutes") are testable.
 */
export function parseWhen(input: string, now: number = Date.now()): ParsedWhen | null {
  const text = input.toLowerCase().trim()
  if (!text) return null

  const time = matchTimeOfDay(text)

  // "in 10 minutes" — a relative one-shot. Checked first because it's the one
  // form that means an absolute instant rather than a rule, and because "in 2
  // hours" would otherwise fall through to the bare-time branch.
  const relative = text.match(/\bin\s+(?:about\s+|around\s+|~\s*)?(\d+)\s*([a-z]+)/)
  if (relative) {
    const unit = UNIT_WORDS[relative[2]]
    const count = Number(relative[1])
    if (unit && count > 0) {
      // The one label not taken from `describeRecurrence`: "in 10 minutes" is
      // what the user asked for and what they want confirmed back, where the
      // stored rule can only describe itself as a clock time.
      return {
        recurrence: { type: 'once', hour: 0, minute: 0, runAt: now + toMs(count, unit) },
        label: `Once, in ${pluralize(count, unit)}`,
        note: null
      }
    }
  }

  // Fixed-word shorthands.
  if (/\bhourly\b/.test(text)) {
    return accept({
      type: 'interval',
      hour: 0,
      minute: 0,
      every: 1,
      intervalUnit: 'hours',
      anchorAt: now
    })
  }
  if (/\bnightly\b/.test(text)) {
    const at = time ?? { hour: 22, minute: 0 }
    return accept({ type: 'daily', hour: at.hour, minute: at.minute })
  }

  // Weekly forms. Checked before the numeric interval so "every Friday" isn't
  // shadowed, and before "daily" so "weekdays" doesn't read as "every day".
  const weeklyAt = time ?? { hour: DEFAULT_HOUR, minute: 0 }
  if (/\bweekdays?\b/.test(text) && !/\bevery\s+\d/.test(text)) {
    return accept({
      type: 'weekly',
      hour: weeklyAt.hour,
      minute: weeklyAt.minute,
      weekdays: WEEKDAYS
    })
  }
  if (/\bweekends?\b/.test(text)) {
    return accept({
      type: 'weekly',
      hour: weeklyAt.hour,
      minute: weeklyAt.minute,
      weekdays: WEEKEND
    })
  }
  const weekday = matchWeekday(text)
  if (weekday !== null) {
    return accept({
      type: 'weekly',
      hour: weeklyAt.hour,
      minute: weeklyAt.minute,
      weekdays: [weekday]
    })
  }

  // "every 30 minutes" — the repeating interval.
  const interval = text.match(/\bevery\s+(?:other\s+)?(\d+)\s*([a-z]+)/)
  if (interval) {
    const unit = UNIT_WORDS[interval[2]]
    const count = Number(interval[1])
    if (unit && count > 0) {
      const { every, intervalUnit } = normalizeInterval(count, unit)
      // The floor only applies to repeats: a one-shot "in 1 minute" is
      // harmless, but a task re-firing every minute hammers the local model.
      const floored = intervalUnit === 'minutes' && every < MIN_INTERVAL_MINUTES
      const applied = floored ? MIN_INTERVAL_MINUTES : every
      return accept(
        {
          type: 'interval',
          hour: 0,
          minute: 0,
          every: applied,
          intervalUnit,
          anchorAt: now
        },
        floored
          ? `Repeats are capped at ${MIN_INTERVAL_MINUTES} minutes — say "in ${pluralize(count, 'minutes')}" for a one-off.`
          : null
      )
    }
  }

  // "every day at 9am" / "daily".
  if (/\b(every\s+day|everyday|daily|each\s+day)\b/.test(text)) {
    const at = time ?? { hour: DEFAULT_HOUR, minute: 0 }
    return accept({ type: 'daily', hour: at.hour, minute: at.minute })
  }

  // A bare time with no repeat word means once, at the next such time.
  if (time) {
    return accept({ type: 'once', hour: time.hour, minute: time.minute })
  }

  return null
}

/** Human description of a recurrence, e.g. "Every day at 9:00 AM", "Every 30 minutes". */
export function describeRecurrence(recurrence: TaskRecurrence): string {
  if (recurrence.type === 'interval') {
    const every = recurrence.every ?? 1
    const unit = recurrence.intervalUnit ?? 'minutes'
    // "Every hour" reads better than "Every 1 hour", and keeps the shorthands
    // ("hourly") describing themselves the same way they were typed.
    if (every === 1) return `Every ${unit.replace(/s$/, '')}`
    return `Every ${pluralize(every, unit)}`
  }

  const time = formatTimeOfDay(recurrence.hour, recurrence.minute)

  if (recurrence.type === 'once') {
    if (recurrence.runAt === undefined) return `Once at ${time}`
    return `Once, at ${formatTimeOfDay(
      new Date(recurrence.runAt).getHours(),
      new Date(recurrence.runAt).getMinutes()
    )}`
  }
  if (recurrence.type === 'daily') return `Every day at ${time}`

  const weekdays = [...(recurrence.weekdays ?? [])].sort((a, b) => a - b)
  if (weekdays.length === 0) return `Weekly at ${time} — pick a day`
  if (weekdays.length === 7) return `Every day at ${time}`
  if (weekdays.length === WEEKDAYS.length && WEEKDAYS.every((d) => weekdays.includes(d))) {
    return `Weekdays at ${time}`
  }
  if (weekdays.length === WEEKEND.length && WEEKEND.every((d) => weekdays.includes(d))) {
    return `Weekends at ${time}`
  }
  return `Every ${weekdays.map((day) => DAY_LABELS[day]).join(', ')} at ${time}`
}
