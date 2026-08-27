import { describe, expect, it } from 'vitest'
import {
  boundPromptItems,
  criticalThinkingContextTokens,
  criticalThinkingSynthesisLimits
} from '../criticalThinkingSynthesisBudget'

describe('Critical Thinking synthesis budgets', () => {
  it('scales prompt, evidence, and output budgets down for small local contexts', () => {
    const small = criticalThinkingSynthesisLimits(4_096)
    const medium = criticalThinkingSynthesisLimits(8_192)
    const cloud = criticalThinkingSynthesisLimits(128_000)

    // Output room tracks the context, so a 4K window is never handed a budget
    // that would leave no space for the evidence it has to reason over.
    expect(small.maxOutputTokens).toBeLessThan(Math.floor(4_096 * 0.45))
    expect(small.maxOutputTokens).toBeLessThan(medium.maxOutputTokens)
    expect(medium.maxOutputTokens).toBeLessThan(cloud.maxOutputTokens)
    expect(small.maxEvidenceChars).toBeLessThan(medium.maxEvidenceChars)
    expect(medium.maxEvidenceChars).toBeLessThan(cloud.maxEvidenceChars)
    // The flat 36,000 ceiling this line used to pin was cancelling the
    // scaling above: a 65,536-token run reached only 30% of the evidence it
    // had gathered. A large context is now governed by its share.
    expect(cloud.maxEvidenceChars).toBeGreaterThan(36_000)
    expect(cloud.maxEvidenceChars).toBe(Math.floor(cloud.maxPromptChars * 0.58))
  })

  it('uses the active local context and conservative cloud catalog fallback', () => {
    expect(criticalThinkingContextTokens('local', null, 8_192)).toBe(8_192)
    expect(criticalThinkingContextTokens('openai', 'unknown-model', undefined)).toBe(128_000)
  })

  it('treats the configured chat budget as a floor for a report, never a ceiling', () => {
    // The caller passes the user's chat-reply setting. A cited report is a
    // different kind of artifact — and on a reasoning model most of the budget
    // goes to hidden thinking before a word is written — so a roomy context
    // gives the report more than the chat setting asked for, not exactly it.
    const roomy = criticalThinkingSynthesisLimits(32_768, 8_192)
    expect(roomy.maxOutputTokens).toBeGreaterThan(8_192)
    // …but the context still governs: a small window cannot be talked into a
    // budget that would crowd out its own evidence.
    const tight = criticalThinkingSynthesisLimits(8_192, 8_192)
    expect(tight.maxOutputTokens).toBeLessThan(8_192)
    expect(tight.maxOutputTokens).toBeLessThanOrEqual(Math.floor(8_192 * 0.45))
    // A report never claims so much output that no evidence fits.
    expect(roomy.maxEvidenceChars).toBeGreaterThan(20_000)
  })

  it('bounds item lists without breaking their outer structure', () => {
    expect(boundPromptItems([' first ', 'second'], 8)).toEqual(['first', 'se…'])
  })

  describe('thoughtTokens (P0-B/P0-E: guaranteed visible-output reserve)', () => {
    it('reserves a fraction of the total for hidden reasoning, guaranteeing the rest for visible output', () => {
      const limits = criticalThinkingSynthesisLimits(8_192)

      expect(limits.thoughtTokens).toBeGreaterThan(0)
      expect(limits.thoughtTokens).toBeLessThan(limits.maxOutputTokens)
      const guaranteedVisible = limits.maxOutputTokens - limits.thoughtTokens
      expect(guaranteedVisible).toBeGreaterThanOrEqual(Math.floor(limits.maxOutputTokens * 0.6))
    })

    it('never exceeds the total output budget it is drawn from, across context sizes', () => {
      for (const contextTokens of [2_048, 4_096, 8_192, 32_768, 200_000]) {
        const limits = criticalThinkingSynthesisLimits(contextTokens)
        expect(limits.thoughtTokens).toBeLessThanOrEqual(limits.maxOutputTokens)
        expect(limits.thoughtTokens).toBeGreaterThanOrEqual(0)
      }
    })
  })
})

describe('Critical Thinking budgets on a large context', () => {
  it('lets the context share govern instead of a flat ceiling', () => {
    // Measured on a real 65,536-token run: the context allowed 141,312 prompt
    // characters and a flat ceiling admitted 80,000; the evidence share allowed
    // 46,400 and a flat ceiling admitted 36,000. The run held 119,843
    // characters of passages, so 30% of its own evidence reached the model
    // while its steps reported those very facts as missing.
    const big = criticalThinkingSynthesisLimits(65_536, 8_192)

    expect(big.maxPromptChars).toBeGreaterThan(80_000)
    expect(big.maxEvidenceChars).toBeGreaterThan(36_000)
    // Still bounded by what the context can actually hold.
    expect(big.maxPromptChars).toBeLessThanOrEqual((big.contextTokens - big.maxOutputTokens) * 3)
  })

  it('grows the evidence budget as the context grows', () => {
    const small = criticalThinkingSynthesisLimits(32_768, 8_192)
    const large = criticalThinkingSynthesisLimits(131_072, 8_192)

    expect(large.maxEvidenceChars).toBeGreaterThan(small.maxEvidenceChars)
  })

  it('leaves a small local context exactly as it was', () => {
    // The raised rails must not change behaviour for modest hardware, where
    // the share has always governed.
    const tiny = criticalThinkingSynthesisLimits(8_192, 8_192)

    expect(tiny.maxPromptChars).toBe((tiny.contextTokens - tiny.maxOutputTokens - 1_024) * 3)
    expect(tiny.maxEvidenceChars).toBe(Math.floor(tiny.maxPromptChars * 0.58))
  })
})
