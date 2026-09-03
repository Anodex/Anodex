import { describe, expect, it } from 'vitest'
import { createSearxngProvider } from '../providers/searxng'

describe('an unreachable instance', () => {
  /**
   * The commonest failure of a self-hosted instance, and it used to arrive as a
   * bare "fetch failed".
   *
   * Measured: a Critical Thinking run executed all six steps against a SearXNG
   * that was not running, finished `partial` with zero sources and zero
   * evidence, and logged no warning or error anywhere. The only clue was the
   * run's own closing line. `fetch` hides the reason on `cause`, so the code
   * has to be read rather than the message matched.
   */
  function refusedFetch(): typeof fetch {
    return () => {
      const error = new TypeError('fetch failed')
      ;(error as unknown as { cause: { code: string } }).cause = { code: 'ECONNREFUSED' }
      return Promise.reject(error)
    }
  }

  it('says the instance is not running, and where it looked', async () => {
    const original = globalThis.fetch
    globalThis.fetch = refusedFetch()
    try {
      const provider = createSearxngProvider('http://localhost:8080')
      await expect(provider.search('anything', 5)).rejects.toThrow(/not reachable/i)
      globalThis.fetch = refusedFetch()
      await expect(provider.search('anything', 5)).rejects.toThrow(/localhost:8080/)
    } finally {
      globalThis.fetch = original
    }
  })

  it('points at the two things a person can actually do about it', async () => {
    const original = globalThis.fetch
    globalThis.fetch = refusedFetch()
    try {
      const provider = createSearxngProvider('http://localhost:8080')
      await expect(provider.search('anything', 5)).rejects.toThrow(
        /start it, or choose a different search provider/i
      )
    } finally {
      globalThis.fetch = original
    }
  })
})
