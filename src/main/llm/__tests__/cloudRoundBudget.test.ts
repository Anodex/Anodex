import { describe, expect, it } from 'vitest'
import {
  advanceCloudSpentTokens,
  cloudToolResultBudget,
  estimateCloudSpentTokens
} from '../cloudRoundBudget'

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

describe('estimateCloudSpentTokens', () => {
  const seed = (parts: Parameters<typeof estimateCloudSpentTokens>[1]) =>
    cloudToolResultBudget(WINDOW, estimateCloudSpentTokens(WINDOW, parts))

  /** One ~800 KB screenshot, as each provider actually renders it. */
  const bytes = 'A'.repeat(Math.ceil((800 * 1024 * 4) / 3))
  const attachments = {
    anthropic: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes } },
    openai: { type: 'input_image', image_url: `data:image/png;base64,${bytes}` },
    chatCompletions: { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes}` } }
  }

  it.each(Object.entries(attachments))(
    'does not count an attached image as prompt text (%s shape)',
    (_shape, attachment) => {
      const withImage = seed({
        rendered: [{ role: 'user', content: [{ type: 'text', text: 'Audit it.' }, attachment] }]
      })
      const withoutImage = seed({
        rendered: [{ role: 'user', content: [{ type: 'text', text: 'Audit it.' }] }]
      })

      // Counting those base64 characters put the estimate at ~273,000 tokens
      // against a 200,000 window, which zeroed the cap — so every tool the
      // model called on the first round handed back an empty result. The
      // attachment's own wrapper fields still cost a few tokens, hence "close
      // to" rather than equal.
      expect(withImage.maxTokensPerResult).toBeGreaterThan(20_000)
      expect(withoutImage.maxTokensPerResult - withImage.maxTokensPerResult).toBeLessThan(100)
    }
  )

  it('keeps long unbroken text that merely looks like base64', () => {
    // A minified bundle or a dump of hashes is indistinguishable from base64 by
    // shape. Dropping it from the estimate would under-count the very prompts
    // most at risk of overrunning the window.
    const minified = seed({
      rendered: [{ role: 'tool', content: 'a1B2c3D4'.repeat(50_000) }]
    })
    const empty = seed({ rendered: [{ role: 'tool', content: '' }] })

    expect(minified.maxTokensPerResult).toBeLessThan(empty.maxTokensPerResult)
  })

  it('never lets an over-large estimate delete the first result', () => {
    // Defence for whatever the next mis-estimate turns out to be: a guess may
    // narrow the first tool result, never eliminate it. Round 1 replaces the
    // guess with the provider's exact figure regardless.
    const budget = seed({
      rendered: [{ role: 'user', content: 'w'.repeat(WINDOW * 40) }]
    })

    expect(budget.maxTokensPerResult).toBeGreaterThan(0)
  })

  it('still shrinks as a genuinely large prompt grows', () => {
    const small = seed({ rendered: [{ content: 'x'.repeat(4_000) }] })
    const large = seed({
      rendered: [{ content: 'x'.repeat(400_000) }]
    })

    expect(large.maxTokensPerResult).toBeLessThan(small.maxTokensPerResult)
  })

  it('counts the system prompt when the provider sends it out of band', () => {
    const withSystem = seed({
      rendered: [{ content: 'hi' }],
      systemPrompt: 'y'.repeat(200_000)
    })
    const without = seed({ rendered: [{ content: 'hi' }] })

    expect(withSystem.maxTokensPerResult).toBeLessThan(without.maxTokensPerResult)
  })
})

describe('advanceCloudSpentTokens', () => {
  it('takes a larger reported figure over the running estimate', () => {
    expect(advanceCloudSpentTokens(1_000, 40_000)).toBe(40_000)
  })

  it('keeps the estimate when a provider reports no usage at all', () => {
    // Common on self-hosted OpenAI-compatible endpoints, where `usage` is
    // absent on a streamed completion. Treating that as zero would reset the
    // budget to a fresh window every round — worse than the estimate it replaced.
    expect(advanceCloudSpentTokens(40_000, undefined)).toBe(40_000)
  })

  it('never lets the spend fall back', () => {
    // Anthropic splits `cache_read_input_tokens` out of `input_tokens`, so a
    // cached round can report a figure far below what the window is really
    // holding. A turn's prompt only grows; the high-water mark is the truth.
    expect(advanceCloudSpentTokens(120_000, 900)).toBe(120_000)
    expect(advanceCloudSpentTokens(120_000, 0)).toBe(120_000)
  })
})
