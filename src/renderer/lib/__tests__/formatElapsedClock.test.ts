import { describe, expect, it } from 'vitest'
import { formatElapsedClock } from '../format'

describe('formatElapsedClock', () => {
  it('counts up like a clock', () => {
    expect(formatElapsedClock(0)).toBe('0:00')
    expect(formatElapsedClock(29_400)).toBe('0:29')
    expect(formatElapsedClock(12 * 60_000 + 4_000)).toBe('12:04')
    expect(formatElapsedClock(3_600_000 + 2 * 60_000 + 9_000)).toBe('1:02:09')
  })

  it('never shows a negative time from a clock that moved backwards', () => {
    expect(formatElapsedClock(-5_000)).toBe('0:00')
  })
})
