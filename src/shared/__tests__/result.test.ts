import { describe, expect, it } from 'vitest'
import { err, ok, toErrorMessage } from '../result'

describe('result', () => {
  describe('ok', () => {
    it('wraps a value in a success result', () => {
      const result = ok(42)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toBe(42)
    })
  })

  describe('err', () => {
    it('wraps an error code and message', () => {
      const result = err('test.failed', 'Something went wrong')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('test.failed')
        expect(result.error.message).toBe('Something went wrong')
      }
    })

    it('includes optional detail when provided', () => {
      const result = err('test.failed', 'Something went wrong', 'extra context')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.detail).toBe('extra context')
    })
  })

  describe('toErrorMessage', () => {
    it('returns the message from an Error instance', () => {
      expect(toErrorMessage(new Error('boom'))).toBe('boom')
    })

    it('returns the string as-is', () => {
      expect(toErrorMessage('plain string')).toBe('plain string')
    })

    it('falls back for unknown values', () => {
      expect(toErrorMessage(123)).toBe('An unexpected error occurred.')
      expect(toErrorMessage(null)).toBe('An unexpected error occurred.')
    })
  })
})
