import { describe, expect, it } from 'vitest'
import { SUMMARY_CONTEXT_TOKENS, summaryContextSize } from '../summaryContextSize'

describe('summaryContextSize', () => {
  it('is built big enough for every background caller at once', () => {
    // Toast, title and suggestion: the order a reply asks for them in. Each
    // smaller request has to fit the context the first one made, or the second
    // rebuilds it, which is the crash this exists to prevent.
    for (const needed of [1024, 1536, 2048, 4096]) {
      expect(summaryContextSize(needed)).toBe(SUMMARY_CONTEXT_TOKENS)
    }
  })

  it('still grows for a caller that needs more', () => {
    expect(summaryContextSize(8192)).toBe(8192)
  })
})
