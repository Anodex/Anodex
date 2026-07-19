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

  it('bounds item lists without breaking their outer structure', () => {
    expect(boundPromptItems([' first ', 'second'], 8)).toEqual(['first', 'se…'])
  })
})
