import { describe, expect, it } from 'vitest'
import { resolveLocalOutputBudget } from '../localOutputBudget'

describe('resolveLocalOutputBudget', () => {
  it('caps the reproduced 8K tool turn at one quarter of context', () => {
    expect(
      resolveLocalOutputBudget({
        contextSize: 8_192,
        inputLimitTokens: 7_373,
        fixedTokens: 4_028,
        requestedMaxTokens: 8_192,
        hasFunctions: true
      })
    ).toEqual({
      requestedMaxTokens: 8_192,
      effectiveMaxTokens: 2_048,
      clamped: true
    })
  })

  it('uses the smaller measured remainder when fixed input leaves less room', () => {
    expect(
      resolveLocalOutputBudget({
        contextSize: 8_192,
        inputLimitTokens: 7_373,
        fixedTokens: 6_500,
        requestedMaxTokens: 4_096,
        hasFunctions: true
      }).effectiveMaxTokens
    ).toBe(873)
  })

  it('does not reduce an already-safe user limit', () => {
    expect(
      resolveLocalOutputBudget({
        contextSize: 8_192,
        inputLimitTokens: 7_373,
        fixedTokens: 4_028,
        requestedMaxTokens: 1_024,
        hasFunctions: true
      })
    ).toEqual({
      requestedMaxTokens: 1_024,
      effectiveMaxTokens: 1_024,
      clamped: false
    })
  })

  it('lets tool-less replies use the full measured remainder', () => {
    expect(
      resolveLocalOutputBudget({
        contextSize: 8_192,
        inputLimitTokens: 7_373,
        fixedTokens: 2_200,
        requestedMaxTokens: 8_192,
        hasFunctions: false
      }).effectiveMaxTokens
    ).toBe(5_173)
  })

  it('turns an omitted or unlimited request into a safe finite ceiling', () => {
    expect(
      resolveLocalOutputBudget({
        contextSize: 4_096,
        inputLimitTokens: 3_687,
        fixedTokens: 2_000,
        requestedMaxTokens: 0,
        hasFunctions: true
      })
    ).toEqual({
      requestedMaxTokens: undefined,
      effectiveMaxTokens: 1_024,
      clamped: true
    })
  })
})
