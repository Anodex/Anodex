import { describe, expect, it } from 'vitest'
import { formatAgo, formatNextRun } from '../relativeTime'

/**
 * `formatNextRun` moved here from the Scheduler UI so the main process could
 * render the same countdown; its own behaviour is still covered by
 * `scheduleFormat.test.ts` through the re-export. The check below is only that
 * the move kept it reachable and unchanged.
 *
 * `formatAgo` is new, and deliberately coarser than the countdown. A countdown
 * earns its seconds because the reader is waiting for it to reach zero; a past
 * timestamp is being recalled, and "1,847s ago" is arithmetic the reader then
 * has to do themselves.
 */
const NOW = new Date('2026-09-02T12:00:00Z').getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('formatAgo', () => {
  it('calls anything inside a minute "just now"', () => {
    expect(formatAgo(NOW, NOW)).toBe('just now')
    expect(formatAgo(NOW - 59_000, NOW)).toBe('just now')
  })

  it('counts whole minutes up to an hour', () => {
    expect(formatAgo(NOW - MINUTE, NOW)).toBe('1m ago')
    expect(formatAgo(NOW - 59 * MINUTE, NOW)).toBe('59m ago')
  })

  it('counts whole hours up to a day', () => {
    expect(formatAgo(NOW - HOUR, NOW)).toBe('1h ago')
    expect(formatAgo(NOW - 23 * HOUR, NOW)).toBe('23h ago')
  })

  it('counts whole days up to a week', () => {
    expect(formatAgo(NOW - DAY, NOW)).toBe('1d ago')
    expect(formatAgo(NOW - 6 * DAY, NOW)).toBe('6d ago')
  })

  it('switches to a date once a relative count stops helping', () => {
    const text = formatAgo(NOW - 40 * DAY, NOW)
    expect(text).not.toContain('ago')
    expect(text).toContain('2026')
  })

  it('says "never" for a missing timestamp rather than rendering the epoch', () => {
    // A task that has never run stores null, and "Jan 1, 1970" would be a
    // confident wrong answer where "never" is the true one.
    expect(formatAgo(null, NOW)).toBe('never')
    expect(formatAgo(undefined, NOW)).toBe('never')
  })

  it('does not render a negative age when a stored time is slightly ahead', () => {
    // Small skew between a persisted timestamp and Date.now() is ordinary and
    // is not worth the string "in -5m ago".
    expect(formatAgo(NOW + 5 * MINUTE, NOW)).toBe('just now')
  })
})

describe('formatNextRun after the move', () => {
  it('still counts down and still reports an absent schedule', () => {
    expect(formatNextRun(NOW + 90 * MINUTE, NOW)).toBe('In 1h 30m')
    expect(formatNextRun(null, NOW)).toBe('Not scheduled')
    expect(formatNextRun(NOW - 1000, NOW)).toBe('Due now')
  })
})
