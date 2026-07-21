import { describe, expect, it } from 'vitest'
import {
  clampModelResultCap,
  computeModelToolResultBudget,
  modelResultCharBudget
} from '../modelResultBudget'

describe('computeModelToolResultBudget', () => {
  it('bounds one result to a small fraction of the exact reproduced 8K deficit', () => {
    // The exact figures recorded in the runtime reliability handoff: an 8,192
    // local context with a 7,373-token input limit and 4,037 fixed tokens
    // left about 3,336 tokens for the whole exchange, yet read_file_range
    // could return up to 60 KiB (tens of thousands of tokens) in one call.
    const budget = computeModelToolResultBudget({
      contextSizeTokens: 8_192,
      inputLimitTokens: 7_373,
      fixedTokens: 4_037
    })

    expect(budget.maxTokensPerResult).toBeGreaterThan(0)
    // Must leave real room for a reply after the reserve on top of the result.
    expect(budget.maxTokensPerResult + budget.minimumReplyReserveTokens).toBeLessThan(
      budget.inputLimitTokens - budget.fixedTokens
    )
    // The old 60 KiB (~15-20K token) disk cap must be nowhere close to fitting.
    expect(modelResultCharBudget(budget)).toBeLessThan(60 * 1024)
  })

  it('serves meaningfully more than ~20-40 lines per call at the tightest observed live-retest cycle', () => {
    // Regression: a live retest reading two large files (2,352 and 1,109
    // lines) to completion consumed 84 tool calls and the full 15-minute
    // bounded-task budget because each `read_file_range` call returned only
    // ~20-40 lines (see `MAX_RESULT_FRACTION_OF_REMAINING`'s doc comment).
    // These are that retest's own tightest-observed figures (after several
    // mid-turn compactions grew fixedTokens from ~4,045 up to 4,587).
    const budget = computeModelToolResultBudget({
      contextSizeTokens: 8_192,
      inputLimitTokens: 7_373,
      fixedTokens: 4_587
    })
    const charBudget = modelResultCharBudget(budget)
    const roughLinesPerCall = charBudget / 35 // ~35 chars/line, this file's own observed average

    // The old 0.22 fraction produced ~27 lines/call here — assert we're now
    // comfortably past that, not just technically "more."
    expect(roughLinesPerCall).toBeGreaterThan(50)
    // Reply space and the absolute result floor both still hold.
    expect(budget.maxTokensPerResult + budget.minimumReplyReserveTokens).toBeLessThan(
      budget.inputLimitTokens - budget.fixedTokens
    )
    expect(budget.maxTokensPerResult).toBeGreaterThanOrEqual(256)
  })

  it('scales down for a 4K context and up for a 32K context relative to 8K', () => {
    const small = computeModelToolResultBudget({
      contextSizeTokens: 4_096,
      inputLimitTokens: 3_686,
      fixedTokens: 2_000
    })
    const medium = computeModelToolResultBudget({
      contextSizeTokens: 8_192,
      inputLimitTokens: 7_373,
      fixedTokens: 4_037
    })
    const large = computeModelToolResultBudget({
      contextSizeTokens: 32_768,
      inputLimitTokens: 29_491,
      fixedTokens: 4_037
    })

    expect(small.maxTokensPerResult).toBeLessThan(medium.maxTokensPerResult)
    expect(medium.maxTokensPerResult).toBeLessThan(large.maxTokensPerResult)
  })

  it('never returns a negative or NaN budget when fixed tokens exceed the input limit', () => {
    const budget = computeModelToolResultBudget({
      contextSizeTokens: 8_192,
      inputLimitTokens: 7_373,
      fixedTokens: 9_000
    })

    expect(budget.maxTokensPerResult).toBe(0)
  })

  it('never returns a negative or NaN budget when the reserve alone exceeds remaining room', () => {
    const budget = computeModelToolResultBudget({
      contextSizeTokens: 4_096,
      inputLimitTokens: 3_686,
      fixedTokens: 3_000
    })

    expect(budget.maxTokensPerResult).toBe(0)
  })

  it('guarantees a minimum usable result once there is any real room at all', () => {
    const budget = computeModelToolResultBudget({
      contextSizeTokens: 4_096,
      inputLimitTokens: 3_686,
      fixedTokens: 1_000
    })

    expect(budget.maxTokensPerResult).toBeGreaterThanOrEqual(256)
  })
})

describe('clampModelResultCap', () => {
  it('returns the requested cap unchanged when no budget is known', () => {
    expect(clampModelResultCap(60 * 1024, null)).toBe(60 * 1024)
  })

  it('clamps down to the runtime budget when it is tighter than the requested cap', () => {
    const budget = computeModelToolResultBudget({
      contextSizeTokens: 8_192,
      inputLimitTokens: 7_373,
      fixedTokens: 4_037
    })

    const clamped = clampModelResultCap(60 * 1024, budget)

    expect(clamped).toBeLessThan(60 * 1024)
    expect(clamped).toBe(modelResultCharBudget(budget))
  })

  it('never widens a requested cap that is already tighter than the runtime budget', () => {
    const budget = computeModelToolResultBudget({
      contextSizeTokens: 1_000_000,
      inputLimitTokens: 1_000_000,
      fixedTokens: 1_000
    })

    expect(clampModelResultCap(500, budget)).toBe(500)
  })
})
