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
    expect(cloud.maxEvidenceChars).toBe(Math.min(140_000, Math.floor(cloud.maxPromptChars * 0.68)))
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

  it('leaves room for the prompt scaffold instead of charging it to the evidence', () => {
    // The shares below are useless unless the caller can actually spend them.
    // `runSynthesis` builds the prompt around the evidence, so the scaffold —
    // the fixed instruction block, plus the question, plan, and findings —
    // comes out of `maxPromptChars` before the packet is sized:
    //
    //   min(maxEvidenceChars, maxPromptChars - promptWithoutEvidence.length)
    //
    // With the scaffold outside the budget, that subtraction is charged
    // entirely to the evidence, and it bites hardest where there is least to
    // give. Measured against the real synthesis prompt:
    //
    //   ctx  4,096 -> share 2,583, delivered    271  (10%)
    //   ctx  8,192 -> share 6,058, delivered  4,944  (82%)
    //   ctx 16,384 -> share 13,542, delivered full
    //
    // A 4K run therefore asks a model to write a cited research report from
    // 271 characters of evidence. Four stored runs on an 8K context
    // (2026-09-04) landed at 4,873-4,901 packet characters and all four
    // reported the passages as too fragmentary to conclude anything.
    //
    // Sizing the shares over the room that remains *after* the scaffold makes
    // the declared share the delivered share on every context.
    // The synthesis prompt's fixed text, measured: 3,203 characters.
    const scaffold = 3_203
    for (const ctx of [4_096, 8_192, 16_384, 32_768, 131_072]) {
      const limits = criticalThinkingSynthesisLimits(ctx, 4_096, scaffold)
      const fixed =
        scaffold + limits.maxQuestionChars + limits.maxPlanChars + limits.maxFindingChars
      // Everything the prompt can hold still fits the prompt.
      expect(fixed + limits.maxEvidenceChars).toBeLessThanOrEqual(limits.maxPromptChars)
      // …and the evidence share survives contact with the caller.
      expect(limits.maxPromptChars - fixed).toBeGreaterThanOrEqual(limits.maxEvidenceChars)
    }
  })

  it('keeps a usable evidence packet on the smallest supported context', () => {
    // 271 characters is not an evidence packet. A 4K window is the floor
    // Anodex supports, not a configuration where the feature may silently
    // stop working.
    const tiny = criticalThinkingSynthesisLimits(4_096, 4_096, 3_203)
    expect(tiny.maxEvidenceChars).toBeGreaterThan(700)
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

  it('governs a small local context by its share, not by the rails', () => {
    // The raised rails must not change behaviour for modest hardware, where
    // the share has always governed. The share itself is now 0.68 rather than
    // 0.58: with the scaffold unaccounted for, the four shares summed to 90%
    // of the budget and the caller quietly spent the remaining 10% on
    // evidence, because it sized the packet from what was left rather than
    // from the share. Now that the scaffold is subtracted up front, keeping
    // the 10% aside would hand a modest context *less* evidence than it used
    // to get — an 8K run measured 4,944 delivered characters before the
    // change and would have got 4,200 after it.
    const tiny = criticalThinkingSynthesisLimits(8_192, 8_192)

    expect(tiny.maxPromptChars).toBe((tiny.contextTokens - tiny.maxOutputTokens - 1_024) * 3)
    expect(tiny.maxEvidenceChars).toBe(Math.floor(tiny.maxPromptChars * 0.68))
    // With no scaffold declared, every share is still cut from the whole
    // prompt, so an existing caller sees the allocation it always did.
    expect(tiny.allocatablePromptChars).toBe(tiny.maxPromptChars)
  })
})
