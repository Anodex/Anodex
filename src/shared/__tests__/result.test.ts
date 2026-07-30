import { afterEach, describe, expect, it, vi } from 'vitest'
import { err, ok, setResultErrorReporter, toErrorMessage } from '../result'

afterEach(() => {
  setResultErrorReporter(null)
})

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

  describe('failure observer', () => {
    it('reports every failure to an attached observer', () => {
      const reporter = vi.fn()
      setResultErrorReporter(reporter)

      err('models.load-failed', 'Failed to load the model.', 'out of VRAM')

      expect(reporter).toHaveBeenCalledWith({
        code: 'models.load-failed',
        message: 'Failed to load the model.',
        detail: 'out of VRAM'
      })
    })

    it('does not let a throwing observer turn one failure into two', () => {
      setResultErrorReporter(() => {
        throw new Error('reporter is broken')
      })

      expect(() => err('a.b', 'message')).not.toThrow()
      expect(err('a.b', 'message').ok).toBe(false)
    })

    it('does not recurse when the observer itself fails through err', () => {
      let calls = 0
      setResultErrorReporter(() => {
        calls += 1
        err('reporter.failed', 'The reporter could not record that.')
      })

      err('original.failed', 'Something failed.')

      expect(calls).toBe(1)
    })

    it('stops reporting once detached', () => {
      const reporter = vi.fn()
      setResultErrorReporter(reporter)
      setResultErrorReporter(null)

      err('a.b', 'message')

      expect(reporter).not.toHaveBeenCalled()
    })

    it('never reports a success', () => {
      const reporter = vi.fn()
      setResultErrorReporter(reporter)

      ok(42)

      expect(reporter).not.toHaveBeenCalled()
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
