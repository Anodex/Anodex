import { describe, expect, it } from 'vitest'
import { toStopDetail } from '../stopDetail'

describe('toStopDetail', () => {
  it('keeps a short provider message as it stands', () => {
    expect(toStopDetail(new Error('429 rate limit exceeded.'))).toBe('429 rate limit exceeded.')
  })

  it('bounds a message long enough to blow out a toast', () => {
    // Provider SDKs put the whole HTTP error body in `message`; for a rejected
    // request that can run to kilobytes of JSON, and it lands in a desktop
    // toast, a persisted agent `lastError`, and a stored run summary.
    const detail = toStopDetail(new Error(`{"error":{"message":"${'x'.repeat(5_000)}"}}`))

    expect(detail!.length).toBeLessThanOrEqual(301)
    expect(detail!.endsWith('…')).toBe(true)
  })

  it('collapses a stack-trace-shaped message onto one line', () => {
    // Otherwise it renders as a wall of blank lines everywhere it is shown.
    expect(toStopDetail(new Error('Request failed\n\n    at foo\n    at bar'))).toBe(
      'Request failed at foo at bar'
    )
  })

  it('carries nothing when there is nothing worth carrying', () => {
    expect(toStopDetail(new Error(''))).toBeUndefined()
    expect(toStopDetail(new Error('   \n  '))).toBeUndefined()
    expect(toStopDetail(undefined)).toBeUndefined()
    expect(toStopDetail(null)).toBeUndefined()
  })

  it('accepts a thrown non-Error rather than losing the reason', () => {
    expect(toStopDetail('socket hang up')).toBe('socket hang up')
  })

  it('serializes a thrown plain object instead of reporting [object Object]', () => {
    // Some SDKs reject with a bare response body. Coercing it hides the reason
    // that was sitting right there in its fields.
    expect(toStopDetail({ code: 'overloaded_error' })).toBe('{"code":"overloaded_error"}')
  })

  it('survives a value that cannot be serialized at all', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(toStopDetail(circular)).toBeUndefined()
  })
})
