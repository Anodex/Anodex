import { describe, expect, it } from 'vitest'
import { describeRecurrence, parseWhen } from '../parseWhen'

/**
 * Monthly schedules, which `parseWhen` silently turned into something else.
 *
 * `monthly` was listed in `REPEAT_WORDS`, so it did its one job there —
 * suppressing the calendar-date branch — and then had no branch of its own.
 * Every monthly phrasing fell through to the bare-time rule at the bottom:
 *
 *   "monthly at 9am"                    ->  {"type":"once","hour":9}
 *   "on the 1st of every month at 9am"  ->  {"type":"once","hour":9}
 *
 * The repeat was dropped, the day was dropped, and the label read "Once at
 * 9:00 AM" — plausible enough that nothing looked wrong until the second
 * month never came.
 *
 * The ordinal form failed the other way, which is worse:
 *
 *   "the last Friday of the month"      ->  {"type":"weekly","weekdays":[5]}
 *
 * `matchWeekday` found "friday" and claimed it. A monthly reminder became a
 * weekly one, firing four to five times more often than asked, labelled
 * "Every Fri at 9:00 AM".
 *
 * `now` is Saturday 5 September 2026, 13:00 local.
 */
const NOW = new Date(2026, 8, 5, 13, 0, 0).getTime()

describe('parseWhen — monthly', () => {
  describe('day of the month', () => {
    it('reads "the Nth of every month"', () => {
      expect(parseWhen('on the 1st of every month at 9am', NOW)?.recurrence).toEqual({
        type: 'monthly',
        hour: 9,
        minute: 0,
        dayOfMonth: 1
      })
    })

    it('reads "the Nth of the month"', () => {
      expect(parseWhen('the 15th of the month at 5pm', NOW)?.recurrence).toEqual({
        type: 'monthly',
        hour: 17,
        minute: 0,
        dayOfMonth: 15
      })
    })

    it('takes a bare "monthly" to mean the day it was set on', () => {
      // Not the 1st: the user never said the 1st, and moving the reminder to a
      // date they didn't mention is the same class of silent wrongness this
      // whole file exists about.
      expect(parseWhen('monthly at 9am', NOW)?.recurrence).toEqual({
        type: 'monthly',
        hour: 9,
        minute: 0,
        dayOfMonth: 5
      })
    })

    it('reads "every month" the same as "monthly"', () => {
      expect(parseWhen('every month at 9am', NOW)?.recurrence).toEqual(
        parseWhen('monthly at 9am', NOW)?.recurrence
      )
    })

    it('defaults the time when none is given', () => {
      expect(parseWhen('the 20th of every month', NOW)?.recurrence).toEqual({
        type: 'monthly',
        hour: 9,
        minute: 0,
        dayOfMonth: 20
      })
    })
  })

  describe('ordinal weekday', () => {
    it('reads "the last Friday of the month" as monthly, not weekly', () => {
      // The regression that mattered most: this used to be {weekly, [5]}.
      expect(parseWhen('the last friday of the month at 9am', NOW)?.recurrence).toEqual({
        type: 'monthly',
        hour: 9,
        minute: 0,
        weekOfMonth: -1,
        weekdays: [5]
      })
    })

    it('reads "first Monday of every month"', () => {
      expect(parseWhen('first monday of every month', NOW)?.recurrence).toEqual({
        type: 'monthly',
        hour: 9,
        minute: 0,
        weekOfMonth: 1,
        weekdays: [1]
      })
    })

    it('reads a numeric ordinal, and prefers it over the day-of-month reading', () => {
      // "2nd Tuesday" contains a bare ordinal too; only one of them is meant.
      expect(parseWhen('the 2nd tuesday of each month at 10am', NOW)?.recurrence).toEqual({
        type: 'monthly',
        hour: 10,
        minute: 0,
        weekOfMonth: 2,
        weekdays: [2]
      })
    })
  })

  describe('periods it cannot express', () => {
    it('rejects "every 2 months" rather than rounding it to monthly', () => {
      // Accepting it would fire twice as often as asked, under a label
      // repeating back exactly what was typed.
      expect(parseWhen('every 2 months at 9am', NOW)).toBeNull()
      expect(parseWhen('every 3 months', NOW)).toBeNull()
    })

    it('rejects "every other month"', () => {
      expect(parseWhen('every other month at 9am', NOW)).toBeNull()
    })

    it('still accepts "every 1 month"', () => {
      expect(parseWhen('every 1 month at 9am', NOW)?.recurrence.type).toBe('monthly')
    })
  })

  describe('bare "weekly"', () => {
    it('stays a repeat instead of collapsing to a one-shot', () => {
      // The identical absence, one row over: `weekly` was in `REPEAT_WORDS`
      // with no branch, so "weekly at 9am" became a single run tomorrow.
      expect(parseWhen('weekly at 9am', NOW)?.recurrence).toEqual({
        type: 'weekly',
        hour: 9,
        minute: 0,
        weekdays: [6]
      })
    })

    it('still lets a named day win', () => {
      expect(parseWhen('weekly on friday at 9am', NOW)?.recurrence.weekdays).toEqual([5])
    })
  })

  describe('round-tripping through describeRecurrence', () => {
    // `WhenField` rewrites its own text input from `describeRecurrence` and
    // re-parses it on the next keystroke. A description `parseWhen` reads back
    // as a different rule makes those two halves disagree forever.
    const inputs = [
      'on the 1st of every month at 9am',
      'the 15th of the month at 5pm',
      'monthly at 9am',
      'the last friday of the month at 9am',
      'first monday of every month',
      'the 2nd tuesday of each month at 10am'
    ]

    for (const input of inputs) {
      it(`survives a round trip: "${input}"`, () => {
        const first = parseWhen(input, NOW)
        expect(first).not.toBeNull()
        const described = describeRecurrence(first!.recurrence)
        const second = parseWhen(described, NOW)
        expect(second?.recurrence).toEqual(first!.recurrence)
        expect(describeRecurrence(second!.recurrence)).toBe(described)
      })
    }
  })

  describe('what it must not have changed', () => {
    it('leaves a dated one-shot alone', () => {
      const parsed = parseWhen('October 15 2026 at 10am', NOW)
      expect(parsed?.recurrence.type).toBe('once')
      expect(new Date(parsed!.recurrence.runAt!).getMonth()).toBe(9)
      expect(new Date(parsed!.recurrence.runAt!).getDate()).toBe(15)
    })

    it('leaves "every Friday" weekly', () => {
      expect(parseWhen('every friday at 4pm', NOW)?.recurrence).toEqual({
        type: 'weekly',
        hour: 16,
        minute: 0,
        weekdays: [5]
      })
    })

    it('leaves weekdays, intervals and daily alone', () => {
      expect(parseWhen('weekdays at 5pm', NOW)?.recurrence.weekdays).toEqual([1, 2, 3, 4, 5])
      expect(parseWhen('every 30 minutes', NOW)?.recurrence.type).toBe('interval')
      expect(parseWhen('every day at 9am', NOW)?.recurrence.type).toBe('daily')
      expect(parseWhen('every 2 weeks', NOW)?.recurrence.type).toBe('interval')
    })
  })
})
