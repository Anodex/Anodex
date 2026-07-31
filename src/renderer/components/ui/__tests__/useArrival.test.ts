import { describe, expect, it } from 'vitest'
import { ARRIVAL_WINDOW_MS, claimArrival, isUnannouncedArrival } from '../useArrival'

const NOW = new Date(2026, 6, 23, 18, 30, 0, 0).getTime()

describe('isUnannouncedArrival', () => {
  it('announces something that landed just now', () => {
    expect(isUnannouncedArrival('fresh', NOW - 1000, NOW)).toBe(true)
  })

  it('stops announcing once the landing is older than the window', () => {
    expect(isUnannouncedArrival('stale', NOW - ARRIVAL_WINDOW_MS - 1, NOW)).toBe(false)
  })

  it('treats the window edge as still worth announcing', () => {
    expect(isUnannouncedArrival('edge', NOW - ARRIVAL_WINDOW_MS, NOW)).toBe(true)
  })

  it('never announces the same landing twice, which is what stops a replay', () => {
    expect(isUnannouncedArrival('once', NOW, NOW)).toBe(true)
    claimArrival('once')
    expect(isUnannouncedArrival('once', NOW, NOW)).toBe(false)
  })

  it('keys on the landing, so a later run of the same thing still announces', () => {
    claimArrival('task_1:1000')
    expect(isUnannouncedArrival('task_1:1000', NOW, NOW)).toBe(false)
    expect(isUnannouncedArrival('task_1:2000', NOW, NOW)).toBe(true)
  })
})
