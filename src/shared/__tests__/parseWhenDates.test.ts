import { describe, expect, it } from 'vitest'
import { parseWhen } from '../parseWhen'

/**
 * Calendar dates, which `parseWhen` silently discarded.
 *
 * Found through the Scheduler, from a real email. A message said "you have a
 * meeting at 9:00Am on 9-4-26". The assistant resolved that correctly to
 * Friday 4 September 2026, said so, and asked for a reminder — and the task
 * that got saved was:
 *
 *   {"type":"once","hour":9,"minute":0}   ->  Thursday 3 September, 09:00
 *
 * The time matched; the date matched nothing and was dropped; "once at 9:00"
 * then resolved to the next 9am, which was the following morning. A reminder
 * for a meeting fired a day early, and nothing anywhere said the date had been
 * ignored. The label read "Once, at 9:00 AM", which looks entirely reasonable.
 *
 * `schedule_task` also advertises "tomorrow at noon" in its own description,
 * which the parser never implemented. Said in the afternoon it happened to be
 * right; said in the morning it meant today.
 *
 * `now` is Wednesday 2 September 2026, 13:00 local — the moment the real bug
 * was caught, so these read against the same clock.
 */
const NOW = new Date(2026, 8, 2, 13, 0, 0).getTime()

/** The local-time instant a parsed one-shot will actually fire. */
function firesAt(input: string): Date | null {
  const parsed = parseWhen(input, NOW)
  if (!parsed || parsed.recurrence.type !== 'once') return null
  const runAt = parsed.recurrence.runAt
  return runAt === undefined ? null : new Date(runAt)
}

function expectLocal(
  input: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0
): void {
  const actual = firesAt(input)
  expect(actual, `"${input}" did not parse to a dated one-shot`).not.toBeNull()
  expect(actual).toEqual(new Date(year, month, day, hour, minute, 0, 0))
}

describe('parseWhen with a calendar date', () => {
  describe('the case that was silently wrong', () => {
    it('keeps the date from "September 4, 2026 at 9:00 AM"', () => {
      expectLocal('September 4, 2026 at 9:00 AM', 2026, 8, 4, 9)
    })

    it('keeps the date from the abbreviated month', () => {
      expectLocal('Sep 4 2026 at 9am', 2026, 8, 4, 9)
    })

    it('keeps the date written day-first', () => {
      expectLocal('4 September 2026 at 9am', 2026, 8, 4, 9)
    })

    it('reads an ISO date', () => {
      expectLocal('2026-09-04 at 9:00', 2026, 8, 4, 9)
    })
  })

  describe('relative days, one of which the tool already advertised', () => {
    it('parses "tomorrow at noon"', () => {
      expectLocal('tomorrow at noon', 2026, 8, 3, 12)
    })

    it('parses "today at 4pm" when that is still ahead', () => {
      expectLocal('today at 4pm', 2026, 8, 2, 16)
    })

    it('defaults the time when a day is given without one', () => {
      const actual = firesAt('tomorrow')
      expect(actual?.getDate()).toBe(3)
      expect(actual?.getMonth()).toBe(8)
    })
  })

  describe('picking the year when none is given', () => {
    it('uses this year when the date is still ahead', () => {
      expectLocal('September 20 at 9am', 2026, 8, 20, 9)
    })

    it('rolls to next year when the date has already passed', () => {
      // "January 5" said in September means the coming January, not one that
      // is eight months gone.
      expectLocal('January 5 at 9am', 2027, 0, 5, 9)
    })
  })

  describe('what it must not break', () => {
    it('still parses a bare time as the next such time', () => {
      const parsed = parseWhen('at 9am', NOW)
      expect(parsed?.recurrence).toMatchObject({ type: 'once', hour: 9, minute: 0 })
    })

    it('still parses a repeating weekday', () => {
      expect(parseWhen('every Friday at 9am', NOW)?.recurrence).toMatchObject({
        type: 'weekly',
        hour: 9
      })
    })

    it('still parses an interval', () => {
      expect(parseWhen('every 30 minutes', NOW)?.recurrence.type).toBe('interval')
    })

    it('still parses a relative one-shot', () => {
      expect(parseWhen('in 10 minutes', NOW)?.recurrence.type).toBe('once')
    })

    it('does not treat a repeat on a named day as a single date', () => {
      // "every Friday" must stay weekly even though a date parser could see a
      // day name in it.
      expect(parseWhen('every friday', NOW)?.recurrence.type).toBe('weekly')
    })

    it('returns null for text with no time information at all', () => {
      expect(parseWhen('sometime soon', NOW)).toBeNull()
    })
  })

  describe('the label tells the user which day it resolved to', () => {
    it('names the resolved date, not just the time', () => {
      // The original failure was invisible because the label said only
      // "Once, at 9:00 AM". A date in the label is what makes a wrong one
      // catchable on the confirmation card.
      const parsed = parseWhen('September 4, 2026 at 9:00 AM', NOW)
      expect(parsed?.label).toMatch(/Sep|September/)
      expect(parsed?.label).toMatch(/4/)
    })
  })

  describe('a bare ordinal day, with no month beside it', () => {
    // The last of this family. `matchCalendarDate` only recognised a day
    // number next to a month name, so "on the 15th at 9am" matched nothing
    // and became a one-shot today or tomorrow, labelled "Once at 9:00 AM".
    it('keeps the day from "on the 15th at 9am"', () => {
      expectLocal('remind me on the 15th at 9am', 2026, 8, 15, 9)
    })

    it('defaults the time when none is given', () => {
      expectLocal('on the 20th', 2026, 8, 20, 9)
    })

    it('rolls to next month when the day has already gone', () => {
      // NOW is the 2nd, so the 1st is behind us.
      expectLocal('on the 1st at 9am', 2026, 9, 1, 9)
    })

    it('rolls by a month, not a year', () => {
      // The named-month form rolls a year, which is why it compares by date.
      // A bare day rolls one month, so it compares by instant instead.
      expectLocal('the 2nd at 9am', 2026, 9, 2, 9)
    })

    it('keeps today when the time is still ahead', () => {
      expectLocal('the 2nd at 5pm', 2026, 8, 2, 17)
    })

    it('passes over months too short for the day', () => {
      // September has 30 days, so "the 31st" is October's.
      expectLocal('on the 31st at 9am', 2026, 9, 31, 9)
    })

    it('says which day it resolved to', () => {
      // Same reason the named-month form does: a wrong date is only catchable
      // if the confirmation card names one.
      const parsed = parseWhen('on the 15th at 9am', NOW)
      expect(parsed?.label).toMatch(/15/)
      expect(parsed?.label).toMatch(/Sep/)
    })
  })

  describe('what a bare ordinal must not swallow', () => {
    it('leaves an ordinal weekday alone', () => {
      // "the 2nd Tuesday" names a position in a month, not the 2nd of it.
      expect(parseWhen('the 2nd tuesday at 9am', NOW)?.recurrence.type).not.toBe('once')
    })

    it('leaves "the Nth of the month" a monthly rule', () => {
      // Caught this one as a real regression. The phrase carries no "every",
      // no "each" and no whole-word "monthly", so `REPEAT_WORDS` reads it as a
      // single day — harmless while a bare day number matched nothing, and a
      // silent downgrade from a rule to a date the moment one did.
      expect(parseWhen('the 15th of the month at 5pm', NOW)?.recurrence).toEqual({
        type: 'monthly',
        hour: 17,
        minute: 0,
        dayOfMonth: 15
      })
    })

    it('leaves a monthly rule alone', () => {
      expect(parseWhen('the 1st of every month at 9am', NOW)?.recurrence).toEqual({
        type: 'monthly',
        hour: 9,
        minute: 0,
        dayOfMonth: 1
      })
    })

    it('leaves a relative one-shot alone', () => {
      const parsed = parseWhen('in 10 minutes', NOW)
      expect(parsed?.recurrence.runAt).toBe(NOW + 10 * 60_000)
    })

    it('leaves an interval alone', () => {
      expect(parseWhen('every 30 minutes', NOW)?.recurrence.type).toBe('interval')
    })

    it('still prefers a named month when one is present', () => {
      expectLocal('September 4, 2026 at 9:00 AM', 2026, 8, 4, 9)
    })
  })
})
