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
    expect(cloud.maxEvidenceChars).toBe(36_000)
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
