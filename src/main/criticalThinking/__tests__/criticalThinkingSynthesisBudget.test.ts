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

    expect(small.maxOutputTokens).toBe(1_024)
    expect(small.maxEvidenceChars).toBeLessThan(medium.maxEvidenceChars)
    expect(medium.maxEvidenceChars).toBeLessThan(cloud.maxEvidenceChars)
    expect(cloud.maxEvidenceChars).toBe(36_000)
  })

  it('uses the active local context and conservative cloud catalog fallback', () => {
    expect(criticalThinkingContextTokens('local', null, 8_192)).toBe(8_192)
    expect(criticalThinkingContextTokens('openai', 'unknown-model', undefined)).toBe(128_000)
  })

  it('honors a larger configured report budget when the active context can hold it', () => {
    expect(criticalThinkingSynthesisLimits(32_768, 8_192).maxOutputTokens).toBe(8_192)
    expect(criticalThinkingSynthesisLimits(8_192, 8_192).maxOutputTokens).toBe(
      Math.floor(8_192 * 0.3)
    )
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
