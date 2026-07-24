import { describe, expect, it } from 'vitest'
import { describeRecurrence, parseWhen } from '../parseWhen'
import { MIN_INTERVAL_MINUTES } from '../scheduledTask.types'

/** Fixed reference point so the relative forms are deterministic: 2026-07-23, 6:30 PM local. */
const NOW = new Date(2026, 6, 23, 18, 30, 0, 0).getTime()

describe('parseWhen', () => {
  it('returns null for empty or unparseable input', () => {
    expect(parseWhen('', NOW)).toBeNull()
    expect(parseWhen('   ', NOW)).toBeNull()
    expect(parseWhen('banana', NOW)).toBeNull()
    expect(parseWhen('when I feel like it', NOW)).toBeNull()
  })

  describe('relative one-shots', () => {
    it('parses "in N minutes" to an absolute runAt', () => {
      const parsed = parseWhen('in 10 minutes', NOW)
      expect(parsed?.recurrence).toEqual({
        type: 'once',
        hour: 0,
        minute: 0,
        runAt: NOW + 10 * 60_000
      })
      expect(parsed?.label).toBe('Once, in 10 minutes')
    })

    it('reads the exact sentence a user typed into the prompt box', () => {
      // The failure that motivated this parser: this text produced a task 15
      // hours out, because nothing read schedule intent from it.
      const parsed = parseWhen('remind me in 1 mint to check email', NOW)
      expect(parsed?.recurrence.runAt).toBe(NOW + 60_000)
      expect(parsed?.label).toBe('Once, in 1 minute')
    })

    it('is not subject to the repeating-interval floor', () => {
      const parsed = parseWhen('in 1 minute', NOW)
      expect(parsed?.recurrence.runAt).toBe(NOW + 60_000)
      expect(parsed?.note).toBeNull()
    })

    it('accepts hours, days and hedge words', () => {
      expect(parseWhen('in 2 hours', NOW)?.recurrence.runAt).toBe(NOW + 2 * 3_600_000)
      expect(parseWhen('in 3 days', NOW)?.recurrence.runAt).toBe(NOW + 3 * 86_400_000)
      expect(parseWhen('in about 5 mins', NOW)?.recurrence.runAt).toBe(NOW + 5 * 60_000)
    })

    it('rejects a zero or unknown unit rather than guessing', () => {
      expect(parseWhen('in 0 minutes', NOW)).toBeNull()
      expect(parseWhen('in 5 fortnights', NOW)).toBeNull()
    })
  })

  describe('repeating intervals', () => {
    it('parses "every 30 minutes" and anchors it to now', () => {
      const parsed = parseWhen('every 30 minutes', NOW)
      expect(parsed?.recurrence).toEqual({
        type: 'interval',
        hour: 0,
        minute: 0,
        every: 30,
        intervalUnit: 'minutes',
        anchorAt: NOW
      })
      expect(parsed?.label).toBe('Every 30 minutes')
      expect(parsed?.note).toBeNull()
    })

    it('floors a sub-minimum repeat and says so', () => {
      const parsed = parseWhen('every 2 minutes', NOW)
      expect(parsed?.recurrence.every).toBe(MIN_INTERVAL_MINUTES)
      expect(parsed?.label).toBe(`Every ${MIN_INTERVAL_MINUTES} minutes`)
      expect(parsed?.note).toContain('in 2 minutes')
    })

    it('converts weeks to days, since IntervalUnit has no week', () => {
      const parsed = parseWhen('every 2 weeks', NOW)
      expect(parsed?.recurrence.every).toBe(14)
      expect(parsed?.recurrence.intervalUnit).toBe('days')
    })

    it('parses the "hourly" shorthand', () => {
      const parsed = parseWhen('hourly', NOW)
      expect(parsed?.recurrence.every).toBe(1)
      expect(parsed?.recurrence.intervalUnit).toBe('hours')
      expect(parsed?.label).toBe('Every hour')
    })

    it('singularises a one-unit interval, matching the "hourly" wording', () => {
      expect(parseWhen('every 1 hour', NOW)?.label).toBe('Every hour')
      expect(parseWhen('every 1 day', NOW)?.label).toBe('Every day')
    })
  })

  describe('daily and weekly', () => {
    it('parses "every day at 9am"', () => {
      const parsed = parseWhen('every day at 9am', NOW)
      expect(parsed?.recurrence).toEqual({ type: 'daily', hour: 9, minute: 0 })
      expect(parsed?.label).toBe('Every day at 9:00 AM')
    })

    it('defaults a bare "daily" to 9am rather than failing', () => {
      expect(parseWhen('daily', NOW)?.recurrence).toEqual({ type: 'daily', hour: 9, minute: 0 })
    })

    it('parses weekdays and weekends', () => {
      expect(parseWhen('weekdays at 5pm', NOW)?.recurrence).toEqual({
        type: 'weekly',
        hour: 17,
        minute: 0,
        weekdays: [1, 2, 3, 4, 5]
      })
      expect(parseWhen('weekends at 10am', NOW)?.recurrence.weekdays).toEqual([0, 6])
    })

    it('parses a named day, however it is spelled', () => {
      expect(parseWhen('every friday at 4pm', NOW)?.recurrence.weekdays).toEqual([5])
      expect(parseWhen('mondays at 9am', NOW)?.recurrence.weekdays).toEqual([1])
      expect(parseWhen('every tue at 14:30', NOW)?.recurrence).toEqual({
        type: 'weekly',
        hour: 14,
        minute: 30,
        weekdays: [2]
      })
    })

    it('prefers the weekday reading over the numeric interval', () => {
      // "every friday" has no digit, so the interval branch must not swallow it.
      expect(parseWhen('every friday', NOW)?.recurrence.type).toBe('weekly')
    })

    it('parses "nightly" to a 10pm daily', () => {
      expect(parseWhen('nightly', NOW)?.recurrence).toEqual({ type: 'daily', hour: 22, minute: 0 })
    })
  })

  describe('times of day', () => {
    it('parses 12-hour, 24-hour, noon and midnight', () => {
      expect(parseWhen('at 9:30pm', NOW)?.recurrence).toEqual({
        type: 'once',
        hour: 21,
        minute: 30
      })
      expect(parseWhen('at 17:00', NOW)?.recurrence).toEqual({ type: 'once', hour: 17, minute: 0 })
      expect(parseWhen('every day at noon', NOW)?.recurrence).toEqual({
        type: 'daily',
        hour: 12,
        minute: 0
      })
      expect(parseWhen('at midnight', NOW)?.recurrence).toEqual({
        type: 'once',
        hour: 0,
        minute: 0
      })
    })

    it('handles 12am and 12pm without wrapping wrong', () => {
      expect(parseWhen('at 12am', NOW)?.recurrence.hour).toBe(0)
      expect(parseWhen('at 12pm', NOW)?.recurrence.hour).toBe(12)
    })

    it('rejects out-of-range clock values', () => {
      expect(parseWhen('at 25:00', NOW)).toBeNull()
      expect(parseWhen('at 10:75', NOW)).toBeNull()
      expect(parseWhen('at 15pm', NOW)).toBeNull()
    })

    it('does not read a bare number as an o’clock', () => {
      // Without this, "every 30 minutes" could parse as "once at 30:00".
      expect(parseWhen('30', NOW)).toBeNull()
    })
  })
})

describe('describeRecurrence', () => {
  it('describes each recurrence type', () => {
    expect(describeRecurrence({ type: 'once', hour: 9, minute: 0 })).toBe('Once at 9:00 AM')
    expect(describeRecurrence({ type: 'daily', hour: 8, minute: 30 })).toBe('Every day at 8:30 AM')
    expect(
      describeRecurrence({
        type: 'interval',
        hour: 0,
        minute: 0,
        every: 30,
        intervalUnit: 'minutes'
      })
    ).toBe('Every 30 minutes')
  })

  it('collapses the weekday and weekend presets to a phrase', () => {
    expect(
      describeRecurrence({ type: 'weekly', hour: 17, minute: 0, weekdays: [1, 2, 3, 4, 5] })
    ).toBe('Weekdays at 5:00 PM')
    expect(describeRecurrence({ type: 'weekly', hour: 10, minute: 0, weekdays: [0, 6] })).toBe(
      'Weekends at 10:00 AM'
    )
    expect(describeRecurrence({ type: 'weekly', hour: 9, minute: 0, weekdays: [1, 3] })).toBe(
      'Every Mon, Wed at 9:00 AM'
    )
  })

  it('flags a weekly recurrence with no day chosen', () => {
    expect(describeRecurrence({ type: 'weekly', hour: 9, minute: 0, weekdays: [] })).toContain(
      'pick a day'
    )
  })

  it('round-trips everything parseWhen produces', () => {
    for (const input of [
      'every 30 minutes',
      'every day at 9am',
      'weekdays at 5pm',
      'every friday at 4pm',
      'hourly'
    ]) {
      const parsed = parseWhen(input, NOW)
      expect(parsed).not.toBeNull()
      expect(describeRecurrence(parsed!.recurrence)).toBe(parsed!.label)
    }
  })
})
