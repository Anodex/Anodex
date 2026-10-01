import { describe, expect, it } from 'vitest'
import { rateFromSamples, timeLeftLabel } from '../downloadRate'

const MB = 1024 ** 2

describe('rateFromSamples', () => {
  it('waits for a couple of seconds of history before naming a speed', () => {
    expect(
      rateFromSamples(
        [
          { at: 0, bytes: 0 },
          { at: 500, bytes: 40 * MB }
        ],
        null
      )
    ).toBeNull()
  })

  it('measures over the window and projects the time left', () => {
    const rate = rateFromSamples(
      [
        { at: 0, bytes: 100 * MB },
        { at: 4000, bytes: 260 * MB }
      ],
      1260 * MB
    )
    expect(rate?.bytesPerSecond).toBe(40 * MB)
    expect(rate?.secondsLeft).toBe(25)
  })

  it('names no time left when the total is unknown', () => {
    const rate = rateFromSamples(
      [
        { at: 0, bytes: 0 },
        { at: 3000, bytes: 30 * MB }
      ],
      null
    )
    expect(rate?.secondsLeft).toBeNull()
  })
})

describe('timeLeftLabel', () => {
  it('speaks in the units a person waiting would use', () => {
    expect(timeLeftLabel(20)).toBe('Less than a minute left')
    expect(timeLeftLabel(7 * 60 + 10)).toBe('About 7 min left')
    expect(timeLeftLabel(60 * 60)).toBe('About 1 h left')
    expect(timeLeftLabel(95 * 60)).toBe('About 1 h 35 min left')
  })
})
