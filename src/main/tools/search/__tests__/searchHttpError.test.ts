import { describe, expect, it } from 'vitest'
import { describeSearchHttpError } from '../searchHttpError'

/**
 * Every search backend reported a failed request as
 * `${name} returned HTTP ${status}: ${statusText}`.
 *
 * Measured consequence: a run asked for one search, got
 * `Tavily returned HTTP 432: ` — a bare number and an empty half-sentence,
 * because `statusText` is empty on HTTP/2 — retried it three times, and burned
 * all four turns and 10,246 tokens without ever learning that the account's
 * monthly search quota was simply spent.
 *
 * The status is the whole diagnosis in these cases, and the user is the only
 * one who can act on it. It should say so.
 */
describe('describeSearchHttpError', () => {
  it('never leaves a dangling colon when statusText is empty', () => {
    // HTTP/2 has no reason phrase, so `statusText` is '' for most live calls.
    const message = describeSearchHttpError('Tavily', 432, '')
    expect(message).not.toMatch(/:\s*$/)
  })

  it('explains a spent quota rather than quoting the number alone', () => {
    // 432 is Tavily's plan-limit code and means nothing to anyone reading it.
    const message = describeSearchHttpError('Tavily', 432, '')
    expect(message).toContain('Tavily')
    expect(message.toLowerCase()).toContain('quota')
  })

  it('explains a rate limit as distinct from a spent quota', () => {
    const message = describeSearchHttpError('Brave', 429, '')
    expect(message.toLowerCase()).toContain('rate limit')
    // A rate limit clears on its own; a quota does not. Saying so is the point.
    expect(message.toLowerCase()).not.toContain('quota')
  })

  it('points at the key for an auth failure', () => {
    for (const status of [401, 403]) {
      const message = describeSearchHttpError('Google', status, '')
      expect(message.toLowerCase(), `status ${status}`).toContain('key')
    }
  })

  it('blames the provider for a server error, not the user', () => {
    const message = describeSearchHttpError('SearXNG', 502, '')
    expect(message.toLowerCase()).toMatch(/unavailable|server/)
  })

  it('keeps the status code in every message', () => {
    // Whatever the wording, the raw code has to survive for a bug report.
    for (const status of [401, 429, 432, 502, 418]) {
      expect(describeSearchHttpError('Tavily', status, ''), `status ${status}`).toContain(
        String(status)
      )
    }
  })

  it('uses the reason phrase when the server actually sent one', () => {
    const message = describeSearchHttpError('SearXNG', 418, 'I am a teapot')
    expect(message).toContain('I am a teapot')
  })

  it('names the provider that failed', () => {
    // With four backends configurable, "search failed" is not enough to act on.
    expect(describeSearchHttpError('SearXNG', 500, '')).toContain('SearXNG')
    expect(describeSearchHttpError('Brave', 500, '')).toContain('Brave')
  })
})
