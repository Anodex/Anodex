import { describe, expect, it } from 'vitest'
import { findLatestUserRequest, shouldPinCurrentRequest } from '../messageTimeline'

describe('findLatestUserRequest', () => {
  it('selects a new follow-up instead of the older request at the scroll anchor', () => {
    const messages = [
      { id: 'request-1', role: 'user' },
      { id: 'reply-1', role: 'assistant' },
      { id: 'request-2', role: 'user' },
      { id: 'reply-2', role: 'assistant' }
    ]

    expect(findLatestUserRequest(messages)?.id).toBe('request-2')
  })

  it('returns null when the transcript has no user request', () => {
    expect(findLatestUserRequest([{ id: 'system', role: 'system' }])).toBeNull()
  })
})

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
