import { describe, expect, it } from 'vitest'
import {
  describeRecurrence,
  describeRunTiming,
  formatDuration,
  formatNextRun,
  formatTimeOfDay,
  nextRunProgress
} from '../scheduleFormat'

/** Fixed reference point so countdowns don't race the real clock. */
const NOW = new Date(2026, 6, 23, 18, 30, 0, 0).getTime()

describe('formatTimeOfDay', () => {
  it('formats midnight and noon correctly', () => {
    expect(formatTimeOfDay(0, 0)).toBe('12:00 AM')
    expect(formatTimeOfDay(12, 0)).toBe('12:00 PM')
  })

  it('pads minutes and picks the right period', () => {
    expect(formatTimeOfDay(9, 5)).toBe('9:05 AM')
    expect(formatTimeOfDay(21, 30)).toBe('9:30 PM')
  })
})

describe('describeRecurrence', () => {
  it('describes a once recurrence', () => {
    expect(describeRecurrence({ type: 'once', hour: 17, minute: 0 })).toBe('Once at 5:00 PM')
  })

  it('describes a daily recurrence', () => {
    expect(describeRecurrence({ type: 'daily', hour: 8, minute: 0 })).toBe('Every day at 8:00 AM')
  })

  it('describes a weekly recurrence with the weekdays preset', () => {
    expect(
      describeRecurrence({ type: 'weekly', hour: 8, minute: 0, weekdays: [1, 2, 3, 4, 5] })
    ).toBe('Weekdays at 8:00 AM')
  })

  it('describes a weekly recurrence covering every day the same as daily', () => {
    expect(
      describeRecurrence({ type: 'weekly', hour: 8, minute: 0, weekdays: [0, 1, 2, 3, 4, 5, 6] })
    ).toBe('Every day at 8:00 AM')
  })

  it('describes an arbitrary weekly selection', () => {
    expect(describeRecurrence({ type: 'weekly', hour: 16, minute: 0, weekdays: [5, 1] })).toBe(
      'Every Mon, Fri at 4:00 PM'
    )
  })

  it('flags a weekly recurrence with no days selected', () => {
    expect(describeRecurrence({ type: 'weekly', hour: 9, minute: 0, weekdays: [] })).toBe(
      'Weekly at 9:00 AM — pick a day'
    )
  })

  it('describes an interval recurrence', () => {
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

  it('singularizes a 1-unit interval', () => {
    expect(
      describeRecurrence({ type: 'interval', hour: 0, minute: 0, every: 1, intervalUnit: 'hours' })
    ).toBe('Every hour')
  })
})

describe('formatNextRun', () => {
  it('reports not scheduled for null', () => {
    expect(formatNextRun(null, NOW)).toBe('Not scheduled')
  })

  it('reports due now for a past or immediate timestamp', () => {
    expect(formatNextRun(NOW - 1000, NOW)).toBe('Due now')
    expect(formatNextRun(NOW, NOW)).toBe('Due now')
  })

  it('counts seconds inside the last minute, so the label visibly moves', () => {
    expect(formatNextRun(NOW + 42_000, NOW)).toBe('In 42s')
    expect(formatNextRun(NOW + 1000, NOW)).toBe('In 1s')
  })

  it('reports minutes with seconds for a near-future timestamp', () => {
    expect(formatNextRun(NOW + 5 * 60_000, NOW)).toBe('In 5m')
    expect(formatNextRun(NOW + 5 * 60_000 + 20_000, NOW)).toBe('In 5m 20s')
  })

  it('reports hours with minutes for a same-day future timestamp', () => {
    expect(formatNextRun(NOW + 3 * 3_600_000, NOW)).toBe('In 3h')
    expect(formatNextRun(NOW + 3 * 3_600_000 + 30 * 60_000, NOW)).toBe('In 3h 30m')
  })

  it('reports days with hours for a timestamp under a week out', () => {
    expect(formatNextRun(NOW + 3 * 86_400_000, NOW)).toBe('In 3d')
    expect(formatNextRun(NOW + 3 * 86_400_000 + 8 * 3_600_000, NOW)).toBe('In 3d 8h')
  })

  it('switches to an absolute date past a week, where a countdown stops helping', () => {
    expect(formatNextRun(NOW + 9 * 86_400_000, NOW)).not.toContain('In ')
  })
})

describe('nextRunProgress', () => {
  const HOUR = 3_600_000

  it('draws nothing when the task will never fire again', () => {
    expect(nextRunProgress(NOW - HOUR, null, NOW)).toBeNull()
  })

  it('draws nothing when the wait has no known start', () => {
    expect(nextRunProgress(null, NOW + HOUR, NOW)).toBeNull()
  })

  it('reports the fraction of the wait already spent', () => {
    expect(nextRunProgress(NOW - HOUR, NOW + HOUR, NOW)).toBeCloseTo(0.5)
    expect(nextRunProgress(NOW - 3 * HOUR, NOW + HOUR, NOW)).toBeCloseTo(0.75)
  })

  it('clamps rather than overrunning when a run is late', () => {
    expect(nextRunProgress(NOW - 2 * HOUR, NOW - HOUR, NOW)).toBe(1)
  })

  it('clamps rather than going negative when the wait has not started', () => {
    expect(nextRunProgress(NOW + HOUR, NOW + 2 * HOUR, NOW)).toBe(0)
  })

  it('draws nothing for a non-positive span, which has no fraction to show', () => {
    expect(nextRunProgress(NOW, NOW, NOW)).toBeNull()
    expect(nextRunProgress(NOW, NOW - HOUR, NOW)).toBeNull()
  })
})

describe('formatDuration', () => {
  it('scales the unit to the length of the run', () => {
    expect(formatDuration(420)).toBe('420ms')
    expect(formatDuration(4200)).toBe('4.2s')
    expect(formatDuration(18_600)).toBe('18.6s')
    expect(formatDuration(124_000)).toBe('2m 04s')
  })
})

describe('describeRunTiming', () => {
  it('says nothing when a run was on time and lost nothing', () => {
    expect(describeRunTiming(0, 0)).toBeNull()
  })

  it('ignores a delay too small to be worth reporting', () => {
    expect(describeRunTiming(3000, 0)).toBeNull()
  })

  it('explains a real delay by its cause', () => {
    expect(describeRunTiming(150_000, 0)).toBe('started 2m 30s late — another task was running')
  })

  it('reports skipped runs, pluralized', () => {
    expect(describeRunTiming(0, 1)).toBe('1 run skipped')
    expect(describeRunTiming(0, 3)).toBe('3 runs skipped')
  })

  it('reports both when a long run also cost whole slots', () => {
    expect(describeRunTiming(150_000, 2)).toBe(
      'started 2m 30s late — another task was running · 2 runs skipped'
    )
  })
})
