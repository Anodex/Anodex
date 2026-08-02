import { describe, expect, it } from 'vitest'
import { cloudToolResultBudget, estimateCloudInputTokens } from '../cloudRoundBudget'

/** A representative large cloud window, so the numbers below read realistically. */
const WINDOW = 200_000

describe('cloudToolResultBudget', () => {
  it('leaves a fresh window room for a full-size read', () => {
    const budget = cloudToolResultBudget(WINDOW, 2_000)

    // 60 KB — `read_file`'s own cap — is roughly 20k tokens. Early in a turn
    // the budget must not be the thing standing in its way.
    expect(budget.maxTokensPerResult).toBeGreaterThan(20_000)
  })

  it('shrinks monotonically as the turn spends the window', () => {
    const caps = [1_000, 50_000, 120_000, 180_000].map(
      (spent) => cloudToolResultBudget(WINDOW, spent).maxTokensPerResult
    )

    for (let i = 1; i < caps.length; i++) expect(caps[i]).toBeLessThan(caps[i - 1])
  })

  it('reaches zero rather than promising room that is gone', () => {
    // Past the point where a reply still fits, there is nothing to hand a tool
    // result — saying otherwise is how a turn walks off the end of the window.
    expect(cloudToolResultBudget(WINDOW, WINDOW).maxTokensPerResult).toBe(0)
    expect(cloudToolResultBudget(WINDOW, WINDOW * 2).maxTokensPerResult).toBe(0)
  })

  it('treats a nonsense spend as zero rather than inverting the budget', () => {
    expect(cloudToolResultBudget(WINDOW, -5_000).maxTokensPerResult).toBe(
      cloudToolResultBudget(WINDOW, 0).maxTokensPerResult
    )
  })
})

describe('estimateCloudInputTokens', () => {
  it('sums every part and ignores the ones that are absent', () => {
    expect(estimateCloudInputTokens('a'.repeat(400), undefined, 'b'.repeat(400))).toBe(200)
  })

  it('is zero for a request with nothing in it', () => {
    expect(estimateCloudInputTokens(undefined, undefined)).toBe(0)
  })
})
