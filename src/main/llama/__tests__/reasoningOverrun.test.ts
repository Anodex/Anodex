import { describe, expect, it } from 'vitest'
import { defaultThoughtTokenBudget } from '../localOutputBudget'
import {
  MAX_REASONING_OVERRUNS,
  reasoningBudgetTokens,
  reasoningOverrunGuidance
} from '../reasoningOverrun'

describe('reasoningBudgetTokens', () => {
  it('gives the llama-server path the same share the text path budgets', () => {
    // The whole point of the module: one policy, two enforcement mechanisms.
    // If these drift, a model gets a different amount of room to think in
    // purely because its GGUF carries a projector.
    for (const contextSize of [16_384, 32_768, 131_072]) {
      expect(reasoningBudgetTokens(contextSize)).toBe(
        defaultThoughtTokenBudget(Math.floor(contextSize * 0.25))
      )
    }
  })

  it('leaves a round far more room to answer in than to think in', () => {
    // 32,768 is the window the driving conversation ran at, where a round's
    // real allowance measured 15,875 tokens.
    const budget = reasoningBudgetTokens(32_768)
    expect(budget).not.toBeNull()
    expect(budget!).toBeLessThan(15_875 * 0.3)
    // The measured pathology was ~19,000 tokens of reasoning in one segment.
    expect(budget!).toBeLessThan(19_000 / 4)
  })

  it('never collapses to a budget that would cut off a first sentence', () => {
    // The fraction goes small on a small window; the floor is what stops that
    // turning into a worse failure than the runaway it bounds.
    for (const contextSize of [2_048, 4_096, 8_192]) {
      expect(reasoningBudgetTokens(contextSize)!).toBeGreaterThanOrEqual(512)
    }
  })

  it('passes no flag when there is no window to size against', () => {
    // `null` means "leave llama-server's own default alone" — an unmeasured
    // window must not be turned into a guess.
    expect(reasoningBudgetTokens(undefined)).toBeNull()
    expect(reasoningBudgetTokens(0)).toBeNull()
    expect(reasoningBudgetTokens(-1)).toBeNull()
    expect(reasoningBudgetTokens(Number.NaN)).toBeNull()
  })

  it('scales with the window rather than being a fixed number', () => {
    expect(reasoningBudgetTokens(131_072)!).toBeGreaterThan(reasoningBudgetTokens(16_384)!)
  })
})

describe('reasoningOverrunGuidance', () => {
  it('carries the tail of the reasoning back to the model', () => {
    // The live probe measured why this matters: llama.cpp does not replay
    // reasoning into history, so a corrective round that is not handed its own
    // thinking re-derives it and hits the budget again.
    const reasoning = `${'earlier thinking. '.repeat(500)}the camera target is (tx, ty, tz)`

    const guidance = reasoningOverrunGuidance(reasoning)

    expect(guidance).toContain('the camera target is (tx, ty, tz)')
    expect(guidance).toContain('do not start over')
    expect(guidance).toMatch(/next tool call/i)
  })

  it('bounds what it carries, so a runaway cannot be replayed whole', () => {
    const guidance = reasoningOverrunGuidance('x'.repeat(80_000))
    expect(guidance.length).toBeLessThan(3_000)
  })

  it('still gives an instruction when there was no reasoning to carry', () => {
    const guidance = reasoningOverrunGuidance('   ')
    expect(guidance).toMatch(/next tool call/i)
    expect(guidance).not.toContain('left off')
  })
})

describe('MAX_REASONING_OVERRUNS', () => {
  it('is finite, so a model that only ever thinks cannot spend the whole turn', () => {
    expect(MAX_REASONING_OVERRUNS).toBeGreaterThan(0)
    expect(MAX_REASONING_OVERRUNS).toBeLessThanOrEqual(3)
  })
})
