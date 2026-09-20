import { describe, expect, it } from 'vitest'
import { describeRoundTimings, roundTimingsOf } from '../roundTimings'

/**
 * llama-server's `timings` block, as it actually arrives on the final stream
 * chunk — the shapes below are copied from build b10549 answering on the
 * machine this was measured on.
 */
describe('roundTimingsOf', () => {
  it('reads a cold round', () => {
    expect(
      roundTimingsOf({
        timings: {
          cache_n: 0,
          prompt_n: 4785,
          prompt_ms: 6816.997,
          predicted_n: 70,
          predicted_ms: 1714.727
        }
      })
    ).toEqual({
      cachedTokens: 0,
      readTokens: 4785,
      readMs: 6816.997,
      predictedTokens: 70,
      predictedMs: 1714.727
    })
  })

  it('reads a round that found its prefix already cached', () => {
    expect(
      roundTimingsOf({
        timings: {
          cache_n: 5631,
          prompt_n: 4,
          prompt_ms: 90.1,
          predicted_n: 10,
          predicted_ms: 220.1
        }
      })?.cachedTokens
    ).toBe(5631)
  })

  it('ignores every chunk that is not the one carrying timings', () => {
    expect(roundTimingsOf({ choices: [{ delta: { content: 'hi' } }] })).toBeNull()
    expect(roundTimingsOf({ usage: { prompt_tokens: 10 } })).toBeNull()
    expect(roundTimingsOf(null)).toBeNull()
    expect(roundTimingsOf(undefined)).toBeNull()
  })

  it('needs the prompt pair to be worth reporting at all', () => {
    // A build that sends timings without the prompt numbers has told us
    // nothing `usage` did not already say.
    expect(roundTimingsOf({ timings: { predicted_n: 10, predicted_ms: 220 } })).toBeNull()
    expect(roundTimingsOf({ timings: { prompt_n: 'lots', prompt_ms: 10 } })).toBeNull()
  })

  it('treats missing generation numbers as zero rather than dropping the round', () => {
    expect(roundTimingsOf({ timings: { prompt_n: 12, prompt_ms: 30 } })).toEqual({
      cachedTokens: 0,
      readTokens: 12,
      readMs: 30,
      predictedTokens: 0,
      predictedMs: 0
    })
  })
})

describe('describeRoundTimings', () => {
  it('works the rates out so the log does not have to be divided by hand', () => {
    expect(
      describeRoundTimings({
        cachedTokens: 0,
        readTokens: 4785,
        readMs: 6816.997,
        predictedTokens: 70,
        predictedMs: 1714.727
      })
    ).toEqual({
      promptTokens: 4785,
      cachedTokens: 0,
      cacheHitPercent: 0,
      readTokens: 4785,
      readMs: 6817,
      readTokensPerSecond: 702,
      predictedTokens: 70,
      predictedMs: 1715,
      predictedTokensPerSecond: 41
    })
  })

  it('reports the cache hit as the share of the prompt that was free', () => {
    const warm = describeRoundTimings({
      cachedTokens: 5631,
      readTokens: 4,
      readMs: 90,
      predictedTokens: 10,
      predictedMs: 220
    })
    expect(warm.promptTokens).toBe(5635)
    expect(warm.cacheHitPercent).toBe(100)
  })

  it('never divides by zero', () => {
    expect(
      describeRoundTimings({
        cachedTokens: 0,
        readTokens: 0,
        readMs: 0,
        predictedTokens: 0,
        predictedMs: 0
      })
    ).toMatchObject({ cacheHitPercent: 0, readTokensPerSecond: 0, predictedTokensPerSecond: 0 })
  })
})
