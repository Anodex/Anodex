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

/**
 * Which occurrence of a weekday within a month "the last Friday" names. `last`
 * is -1 rather than 5: the last Friday is whichever of the fourth or fifth the
 * month actually ends on, and collapsing it to a fixed number would silently
 * skip the months that have only four.
 */
const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  '1st': 1,
  second: 2,
  '2nd': 2,
  third: 3,
  '3rd': 3,
  fourth: 4,
  '4th': 4,
  last: -1
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
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

/** Text naming a month-long cadence: "monthly", "every month", "of the month". */
const MONTHLY_WORDS = /\bmonthly\b|\b(?:every|each)\s+month\b|\bof\s+(?:the|every|each)\s+month\b/

/**
 * "the last Friday", "2nd Tuesday" — an ordinal paired with a weekday, which is
 * the half of a monthly rule that `weekdays` alone cannot express.
 *
 * Matched before the plain day-of-month, because "the 2nd Tuesday of the month"
 * contains both and only one of them is what was meant.
 */
function matchOrdinalWeekday(text: string): { weekOfMonth: number; weekday: number } | null {
  const ordinals = Object.keys(ORDINAL_WORDS).join('|')
  const days = Object.keys(DAY_WORDS).join('|')
  const found = text.match(new RegExp(`\\b(${ordinals})\\s+(${days})\\b`))
  if (!found) return null
  return { weekOfMonth: ORDINAL_WORDS[found[1]], weekday: DAY_WORDS[found[2]] }
}

/** "the 15th", "on the 3rd" — a bare ordinal day number, 1-31. */
function matchDayOfMonth(text: string): number | null {
  const found = text.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/)
  if (!found) return null
  const day = Number(found[1])
  return day >= 1 && day <= 31 ? day : null
}

/** "3rd" from 3 — used by `describeRecurrence`, and re-read by `matchDayOfMonth`. */
function ordinalSuffix(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return `${day}th`
  const suffix = ['th', 'st', 'nd', 'rd'][day % 10] ?? 'th'
  return `${day}${suffix}`
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

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
]

/** `every`, `daily` and friends: text that means a rule, not a single day. */
const REPEAT_WORDS =
  /\b(every|each|daily|everyday|nightly|hourly|weekly|monthly|weekdays?|weekends?)\b/

/** A specific calendar day, resolved. */
interface CalendarDate {
  year: number
  month: number
  day: number
}

/**
 * A named day: "tomorrow", "September 4", "4 Sep 2026", "2026-09-04".
 *
 * Added because its absence was silent. `parseWhen` matched the time in
 * "September 4, 2026 at 9:00 AM", found nothing it recognised in the rest, and
 * fell through to the bare-time branch — producing "once, at the next 9:00",
 * which was the following morning. A meeting reminder was saved for the wrong
 * day and labelled "Once, at 9:00 AM", which reads perfectly plausible.
 *
 * A year is not required. When one is missing the nearest future occurrence is
 * taken, compared by date rather than by instant: "September 2 at 9am" said at
 * lunchtime on September 2 means this morning, not next year, and rolling a
 * whole year forward over a few hours would be its own silent wrongness.
 */
function matchCalendarDate(text: string, now: number): CalendarDate | null {
  const today = new Date(now)

  if (/\btomorrow\b/.test(text)) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
    return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() }
  }
  if (/\btoday\b|\btonight\b/.test(text)) {
    return { year: today.getFullYear(), month: today.getMonth(), day: today.getDate() }
  }

  const iso = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/)
  if (iso) {
    return { year: Number(iso[1]), month: Number(iso[2]) - 1, day: Number(iso[3]) }
  }

  const monthNames = MONTHS.map((month) => month.slice(0, 3)).join('|')
  // "September 4", "Sep 4th, 2026"
  const monthFirst = text.match(
    new RegExp(`\\b(${monthNames})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`)
  )
  // "4 September", "4th Sep 2026"
  const dayFirst = text.match(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})[a-z]*\\.?(?:,?\\s*(\\d{4}))?\\b`)
  )

  const found = monthFirst
    ? { month: monthFirst[1], day: monthFirst[2], year: monthFirst[3] }
    : dayFirst
      ? { month: dayFirst[2], day: dayFirst[1], year: dayFirst[3] }
      : null
  if (!found) return null

  const month = MONTHS.findIndex((name) => name.startsWith(found.month))
  const day = Number(found.day)
  if (month === -1 || day < 1 || day > 31) return null
  if (found.year) return { year: Number(found.year), month, day }

  // No year given: this one if the day is still ahead, otherwise the next.
  const thisYear = today.getFullYear()
  const candidate = new Date(thisYear, month, day)
  const startOfToday = new Date(thisYear, today.getMonth(), today.getDate())
  return {
    year: candidate.getTime() < startOfToday.getTime() ? thisYear + 1 : thisYear,
    month,
    day
  }
}

/** "Once, Fri, Sep 4, 2026 at 9:00 AM" — the date is the point of it. */
function describeDatedOnce(runAt: number, hour: number, minute: number): string {
  const date = new Date(runAt).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
  return `Once, ${date} at ${formatTimeOfDay(hour, minute)}`
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

  // A named day, before every repeating form so "September 4" is not left to
  // fall through to the bare-time branch — which is exactly how a dated
  // reminder used to lose its date. Skipped entirely when the text carries a
  // repeat word, so "every Friday" stays a weekly rule.
  if (!REPEAT_WORDS.test(text)) {
    const date = matchCalendarDate(text, now)
    if (date) {
      const at = time ?? { hour: DEFAULT_HOUR, minute: 0 }
      const runAt = new Date(date.year, date.month, date.day, at.hour, at.minute, 0, 0).getTime()
      return {
        recurrence: { type: 'once', hour: at.hour, minute: at.minute, runAt },
        // Not `describeRecurrence`: it can only describe a rule, so it renders
        // this as "Once, at 9:00 AM" and hides the very thing that was wrong.
        label: describeDatedOnce(runAt, at.hour, at.minute),
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

  // A period of several months has nowhere to live: `IntervalUnit` counts
  // minutes, hours and days, and no run of days is a fixed number of months.
  // Rejecting says so; rounding it to monthly would fire twice as often as
  // asked, under a label reading exactly what the user typed.
  const multiMonth = text.match(/\bevery\s+(other|\d+)\s*months?\b/)
  if (multiMonth && multiMonth[1] !== '1') return null

  // Monthly forms, ahead of the weekly ones because "the last Friday of the
  // month" names a weekday and would otherwise be read as *every* Friday —
  // four to five times more often than asked, and labelled "Every Fri".
  // A surviving `multiMonth` is "every 1 month", which is just monthly said
  // the long way round.
  if (MONTHLY_WORDS.test(text) || multiMonth) {
    const at = time ?? { hour: DEFAULT_HOUR, minute: 0 }
    const ordinal = matchOrdinalWeekday(text)
    if (ordinal) {
      return accept({
        type: 'monthly',
        hour: at.hour,
        minute: at.minute,
        weekOfMonth: ordinal.weekOfMonth,
        weekdays: [ordinal.weekday]
      })
    }
    return accept({
      type: 'monthly',
      hour: at.hour,
      minute: at.minute,
      // A bare "monthly" names no day, so it means the day it was set on —
      // the same reading as "monthly from today". Guessing the 1st instead
      // would move the reminder to a date the user never mentioned.
      dayOfMonth: matchDayOfMonth(text) ?? new Date(now).getDate()
    })
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
  // "weekly at 9am" with no day named. `weekly` sits in `REPEAT_WORDS` but had
  // no branch of its own, so it fell all the way through to the bare-time rule
  // and became a *one-shot* tomorrow morning — the repeat silently dropped,
  // under the label "Once at 9:00 AM". Same shape as the monthly bug above.
  if (/\bweekly\b|\b(?:every|each)\s+week\b/.test(text)) {
    return accept({
      type: 'weekly',
      hour: weeklyAt.hour,
      minute: weeklyAt.minute,
      weekdays: [new Date(now).getDay()]
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

  if (recurrence.type === 'monthly') {
    // Every branch below has to read back into the same rule: the editor
    // rewrites its own text field from this string, so a description
    // `parseWhen` cannot re-read would make the two halves of `WhenField`
    // disagree about the schedule on every keystroke.
    if (recurrence.weekOfMonth !== undefined) {
      const day = DAY_NAMES[recurrence.weekdays?.[0] ?? 0]
      const which = recurrence.weekOfMonth === -1 ? 'last' : ordinalSuffix(recurrence.weekOfMonth)
      return `Monthly on the ${which} ${day} at ${time}`
    }
    return `Monthly on the ${ordinalSuffix(recurrence.dayOfMonth ?? 1)} at ${time}`
  }

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
