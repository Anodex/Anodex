import { describe, expect, it } from 'vitest'
import { shouldPinCurrentRequest } from '../messageTimeline'

describe('shouldPinCurrentRequest', () => {
  it('does not pin the current request while its message is still in view', () => {
    expect(shouldPinCurrentRequest({ messageTop: 120, scrollTop: 80 })).toBe(false)
  })

  it('pins the current request once the user message has scrolled above the viewport', () => {
    expect(shouldPinCurrentRequest({ messageTop: 80, scrollTop: 120 })).toBe(true)
  })

  it('uses a small offset so the sticky request does not flash at the boundary', () => {
    expect(shouldPinCurrentRequest({ messageTop: 112, scrollTop: 120, offset: 16 })).toBe(false)
    expect(shouldPinCurrentRequest({ messageTop: 100, scrollTop: 120, offset: 16 })).toBe(true)
  })
})
