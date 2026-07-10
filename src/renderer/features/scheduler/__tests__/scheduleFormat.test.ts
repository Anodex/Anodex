import { describe, expect, it } from 'vitest'
import { describeRecurrence, formatNextRun, formatTimeOfDay } from '../scheduleFormat'

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
      describeRecurrence({ type: 'interval', hour: 0, minute: 0, every: 30, intervalUnit: 'minutes' })
    ).toBe('Every 30 minutes')
  })

  it('singularizes a 1-unit interval', () => {
    expect(
      describeRecurrence({ type: 'interval', hour: 0, minute: 0, every: 1, intervalUnit: 'hours' })
    ).toBe('Every 1 hour')
  })
})

describe('formatNextRun', () => {
  it('reports not scheduled for null', () => {
    expect(formatNextRun(null)).toBe('Not scheduled')
  })

  it('reports due now for a past or immediate timestamp', () => {
    expect(formatNextRun(Date.now() - 1000)).toBe('Due now')
  })

  it('reports minutes for a near-future timestamp', () => {
    expect(formatNextRun(Date.now() + 5 * 60_000)).toBe('In 5m')
  })

  it('reports hours for a same-day future timestamp', () => {
    expect(formatNextRun(Date.now() + 3 * 3_600_000)).toBe('In 3h')
  })

  it('reports days for a future timestamp under a week out', () => {
    expect(formatNextRun(Date.now() + 3 * 86_400_000)).toBe('In 3d')
  })
})
