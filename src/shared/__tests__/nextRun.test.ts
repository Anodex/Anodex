import { describe, expect, it } from 'vitest'
import { MIN_INTERVAL_MINUTES } from '../scheduledTask.types'
import { computeNextRunAt, slotsBetween } from '../nextRun'

// Wednesday, 2026-07-08 10:00:00 local time.
const WED_10AM = new Date(2026, 6, 8, 10, 0, 0, 0).getTime()

describe('computeNextRunAt', () => {
  describe('interval', () => {
    it('fires every N minutes from fromMs', () => {
      const result = computeNextRunAt(
        { type: 'interval', hour: 0, minute: 0, every: 30, intervalUnit: 'minutes' },
        WED_10AM,
        false
      )
      expect(result).toBe(WED_10AM + 30 * 60_000)
    })

    it('fires every N hours from fromMs', () => {
      const result = computeNextRunAt(
        { type: 'interval', hour: 0, minute: 0, every: 2, intervalUnit: 'hours' },
        WED_10AM,
        true
      )
      expect(result).toBe(WED_10AM + 2 * 60 * 60_000)
    })

    it('fires every N days from fromMs', () => {
      const result = computeNextRunAt(
        { type: 'interval', hour: 0, minute: 0, every: 3, intervalUnit: 'days' },
        WED_10AM,
        true
      )
      expect(result).toBe(WED_10AM + 3 * 24 * 60 * 60_000)
    })

    it('clamps below the minimum interval', () => {
      const result = computeNextRunAt(
        { type: 'interval', hour: 0, minute: 0, every: 1, intervalUnit: 'minutes' },
        WED_10AM,
        true
      )
      expect(result).toBe(WED_10AM + MIN_INTERVAL_MINUTES * 60_000)
    })

    it('defaults to the minimum interval when every/intervalUnit are missing', () => {
      const result = computeNextRunAt({ type: 'interval', hour: 0, minute: 0 }, WED_10AM, true)
      expect(result).toBe(WED_10AM + MIN_INTERVAL_MINUTES * 60_000)
    })
  })

  describe('interval anchoring', () => {
    const every30 = {
      type: 'interval' as const,
      hour: 0,
      minute: 0,
      every: 30,
      intervalUnit: 'minutes' as const,
      anchorAt: WED_10AM
    }

    it('lands on the grid rather than chaining off the previous finish time', () => {
      // A run started at 10:00 and took 12 minutes. Without anchoring the next
      // run would be 10:42; on the grid it stays 10:30.
      const finishedAt = WED_10AM + 12 * 60_000
      expect(computeNextRunAt(every30, finishedAt, true)).toBe(WED_10AM + 30 * 60_000)
    })

    it('does not drift across many cycles', () => {
      // Each run overruns by 12 minutes; after 4 cycles an unanchored schedule
      // would be ~48 minutes off. The grid keeps every slot exact.
      let at = WED_10AM
      for (let cycle = 1; cycle <= 4; cycle++) {
        at = computeNextRunAt(every30, at + 12 * 60_000, true)!
        expect(at).toBe(WED_10AM + cycle * 30 * 60_000)
      }
    })

    it('skips slots missed while the app was closed instead of replaying them', () => {
      const threeHoursLater = WED_10AM + 3 * 60 * 60_000 + 5 * 60_000
      expect(computeNextRunAt(every30, threeHoursLater, true)).toBe(
        WED_10AM + 3 * 60 * 60_000 + 30 * 60_000
      )
    })

    it('returns the next slot, never the current instant, when asked exactly on the grid', () => {
      expect(computeNextRunAt(every30, WED_10AM, false)).toBe(WED_10AM + 30 * 60_000)
      expect(computeNextRunAt(every30, WED_10AM + 30 * 60_000, true)).toBe(WED_10AM + 60 * 60_000)
    })

    it('handles an anchor in the future (a task created ahead of its first slot)', () => {
      const anchoredAhead = { ...every30, anchorAt: WED_10AM + 60 * 60_000 }
      expect(computeNextRunAt(anchoredAhead, WED_10AM, false)).toBe(WED_10AM + 60 * 60_000)
    })
  })

  describe('slotsBetween', () => {
    const every30 = {
      type: 'interval' as const,
      hour: 0,
      minute: 0,
      every: 30,
      intervalUnit: 'minutes' as const,
      anchorAt: WED_10AM
    }
    const minute = 60_000

    it('reports no loss when one slot leads straight to the next', () => {
      expect(slotsBetween(every30, WED_10AM, WED_10AM + 30 * minute)).toBe(0)
    })

    it('counts whole slots passed over by an overrunning run', () => {
      // Scheduled 10:00, next resolved to 11:30 — the 10:30 and 11:00 runs
      // never happened.
      expect(slotsBetween(every30, WED_10AM, WED_10AM + 90 * minute)).toBe(2)
    })

    it('counts a long closure in slots, not in runs replayed', () => {
      expect(slotsBetween(every30, WED_10AM, WED_10AM + 24 * 60 * minute)).toBe(47)
    })

    it('is meaningless for non-interval recurrences, so reports zero', () => {
      expect(
        slotsBetween({ type: 'daily', hour: 9, minute: 0 }, WED_10AM, WED_10AM + 48 * 60 * minute)
      ).toBe(0)
    })

    it('reports zero when either end is unscheduled', () => {
      expect(slotsBetween(every30, null, WED_10AM)).toBe(0)
      expect(slotsBetween(every30, WED_10AM, null)).toBe(0)
    })
  })
  describe('once', () => {
    it('fires later today if the time has not passed yet', () => {
      const result = computeNextRunAt({ type: 'once', hour: 14, minute: 30 }, WED_10AM, false)
      expect(result).toBe(new Date(2026, 6, 8, 14, 30, 0, 0).getTime())
    })

    it('rolls to tomorrow if the time already passed today', () => {
      const result = computeNextRunAt({ type: 'once', hour: 9, minute: 0 }, WED_10AM, false)
      expect(result).toBe(new Date(2026, 6, 9, 9, 0, 0, 0).getTime())
    })

    it('never fires again once it has already run', () => {
      const result = computeNextRunAt({ type: 'once', hour: 14, minute: 30 }, WED_10AM, true)
      expect(result).toBeNull()
    })

    it('fires at runAt exactly when set, which hour/minute cannot express', () => {
      // "in 1 minute" — the case that motivated runAt. A plain hour/minute
      // one-shot can only mean "next time the clock reads H:MM".
      const runAt = WED_10AM + 60_000
      expect(computeNextRunAt({ type: 'once', hour: 0, minute: 0, runAt }, WED_10AM, false)).toBe(
        runAt
      )
    })

    it('still stops after a runAt one-shot has run', () => {
      const runAt = WED_10AM + 60_000
      expect(
        computeNextRunAt({ type: 'once', hour: 0, minute: 0, runAt }, WED_10AM, true)
      ).toBeNull()
    })
  })

  describe('daily', () => {
    it('fires later today if the time has not passed yet', () => {
      const result = computeNextRunAt({ type: 'daily', hour: 20, minute: 0 }, WED_10AM, false)
      expect(result).toBe(new Date(2026, 6, 8, 20, 0, 0, 0).getTime())
    })

    it('rolls to tomorrow if the time already passed today', () => {
      const result = computeNextRunAt({ type: 'daily', hour: 8, minute: 0 }, WED_10AM, false)
      expect(result).toBe(new Date(2026, 6, 9, 8, 0, 0, 0).getTime())
    })

    it('keeps recurring regardless of hasRunBefore', () => {
      const result = computeNextRunAt({ type: 'daily', hour: 8, minute: 0 }, WED_10AM, true)
      expect(result).toBe(new Date(2026, 6, 9, 8, 0, 0, 0).getTime())
    })

    it('rolls over midnight correctly', () => {
      const lateNight = new Date(2026, 6, 8, 23, 50, 0, 0).getTime()
      const result = computeNextRunAt({ type: 'daily', hour: 0, minute: 5 }, lateNight, false)
      expect(result).toBe(new Date(2026, 6, 9, 0, 5, 0, 0).getTime())
    })
  })

  describe('weekly', () => {
    it('returns null when no weekdays are selected', () => {
      const result = computeNextRunAt(
        { type: 'weekly', hour: 9, minute: 0, weekdays: [] },
        WED_10AM,
        false
      )
      expect(result).toBeNull()
    })

    it('fires later today if today is a selected weekday and the time has not passed', () => {
      // Wednesday = 3.
      const result = computeNextRunAt(
        { type: 'weekly', hour: 14, minute: 0, weekdays: [3] },
        WED_10AM,
        false
      )
      expect(result).toBe(new Date(2026, 6, 8, 14, 0, 0, 0).getTime())
    })

    it('rolls to the next selected weekday when today already passed', () => {
      // Weekdays preset: Mon-Fri, but the 9am slot today (Wed) already passed.
      const result = computeNextRunAt(
        { type: 'weekly', hour: 9, minute: 0, weekdays: [1, 2, 3, 4, 5] },
        WED_10AM,
        false
      )
      expect(result).toBe(new Date(2026, 6, 9, 9, 0, 0, 0).getTime()) // Thursday
    })

    it('rolls forward into next week when the only selected weekday already passed this week', () => {
      // Only Wednesday selected, 9am slot already passed today.
      const result = computeNextRunAt(
        { type: 'weekly', hour: 9, minute: 0, weekdays: [3] },
        WED_10AM,
        false
      )
      expect(result).toBe(new Date(2026, 6, 15, 9, 0, 0, 0).getTime()) // next Wednesday
    })

    it('skips over unselected weekdays to find the next match', () => {
      // Only Friday and Monday selected.
      const result = computeNextRunAt(
        { type: 'weekly', hour: 9, minute: 0, weekdays: [5, 1] },
        WED_10AM,
        false
      )
      expect(result).toBe(new Date(2026, 6, 10, 9, 0, 0, 0).getTime()) // Friday
    })
  })
})
