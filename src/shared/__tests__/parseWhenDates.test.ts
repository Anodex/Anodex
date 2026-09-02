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
})
