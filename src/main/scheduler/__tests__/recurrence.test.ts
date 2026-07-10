import { describe, expect, it } from 'vitest'
import { MIN_INTERVAL_MINUTES } from '@shared/scheduledTask.types'
import { computeNextRunAt } from '../recurrence'

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
