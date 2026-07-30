import { describe, expect, it } from 'vitest'
import { defaultThoughtTokenBudget, resolveLocalOutputBudget } from '../localOutputBudget'

describe('resolveLocalOutputBudget', () => {
  it('reserves a bounded fraction of measured headroom for a tool turn instead of a flat quarter of context', () => {
    // The exact live failure recorded in LIVE_8K_FAILURE_RECOVERY_HANDOFF.md:
    // the old quarter-of-context rule clamped this to 2,048 tokens and the
    // model spent nearly all of it on hidden reasoning before one tool call
    // finished. The reserve-of-measured-headroom rule keeps a real safety
    // margin against a malformed call without discarding 1,278 tokens that
    // have nothing to do with the actual fixed prompt.
    const result = resolveLocalOutputBudget({
      contextSize: 8_192,
      inputLimitTokens: 7_373,
      fixedTokens: 4_047,
      requestedMaxTokens: 8_192,
      hasFunctions: true
    })

    expect(result.effectiveMaxTokens).toBe(2_828)
    expect(result.effectiveMaxTokens).toBeGreaterThan(2_048)
    // Never exceed what was actually measured available for this turn.
    expect(result.effectiveMaxTokens).toBeLessThan(7_373 - 4_047)
    expect(result.clamped).toBe(true)
  })

  it('caps the reproduced 8K tool turn using the measured-headroom reserve', () => {
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
      effectiveMaxTokens: 2_844,
      clamped: true
    })
  })

  it('still reserves a safety margin when fixed input leaves little room, but never below the function-output floor', () => {
    expect(
      resolveLocalOutputBudget({
        contextSize: 8_192,
        inputLimitTokens: 7_373,
        fixedTokens: 6_500,
        requestedMaxTokens: 4_096,
        hasFunctions: true
      }).effectiveMaxTokens
    ).toBe(617)
  })

  it('never lets the reserve push the ceiling below the minimum function-output floor', () => {
    // Measured availability (700) comfortably exceeds the floor (512), but
    // subtracting the reserve (256) alone would leave only 444 — the floor
    // wins here instead of the raw subtraction.
    const result = resolveLocalOutputBudget({
      contextSize: 8_192,
      inputLimitTokens: 7_373,
      fixedTokens: 6_673,
      requestedMaxTokens: 8_192,
      hasFunctions: true
    })

    expect(result.effectiveMaxTokens).toBe(512)
    expect(result.effectiveMaxTokens).toBeLessThanOrEqual(7_373 - 6_673)
  })

  it('caps output to measured availability when that availability is itself below the floor', () => {
    // Availability (273) is smaller than MIN_FUNCTION_OUTPUT_TOKENS — the
    // function can never return more tokens than were actually measured.
    const result = resolveLocalOutputBudget({
      contextSize: 8_192,
      inputLimitTokens: 7_373,
      fixedTokens: 7_100,
      requestedMaxTokens: 8_192,
      hasFunctions: true
    })

    expect(result.effectiveMaxTokens).toBe(273)
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

  it('lets tool-less replies use the full measured remainder, unaffected by the function reserve', () => {
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
      effectiveMaxTokens: 1_431,
      clamped: true
    })
  })

  it('never exceeds measured available capacity regardless of context size', () => {
    for (const contextSize of [4_096, 8_192, 16_384, 32_768]) {
      const inputLimitTokens = Math.floor(contextSize * 0.9)
      const fixedTokens = Math.floor(inputLimitTokens * 0.5)
      const result = resolveLocalOutputBudget({
        contextSize,
        inputLimitTokens,
        fixedTokens,
        requestedMaxTokens: contextSize,
        hasFunctions: true
      })
      expect(result.effectiveMaxTokens).toBeLessThanOrEqual(inputLimitTokens - fixedTokens)
    }
  })
})

describe('defaultThoughtTokenBudget', () => {
  it('reserves a minority for thought, guaranteeing a majority for visible output', () => {
    const effectiveMaxTokens = 2_832 // the exact reproduced live 8K tool-turn budget
    const thoughtTokens = defaultThoughtTokenBudget(effectiveMaxTokens)

    expect(thoughtTokens).toBeGreaterThan(0)
    expect(thoughtTokens).toBeLessThan(effectiveMaxTokens)
    const guaranteedVisible = effectiveMaxTokens - thoughtTokens
    expect(guaranteedVisible).toBeGreaterThanOrEqual(Math.floor(effectiveMaxTokens * 0.6))
  })

  it('never exceeds the total it is drawn from, across a range of budgets', () => {
    for (const effectiveMaxTokens of [0, 1, 512, 2_832, 8_192, 100_000]) {
      const thoughtTokens = defaultThoughtTokenBudget(effectiveMaxTokens)
      expect(thoughtTokens).toBeGreaterThanOrEqual(0)
      expect(thoughtTokens).toBeLessThanOrEqual(effectiveMaxTokens)
    }
  })
})
