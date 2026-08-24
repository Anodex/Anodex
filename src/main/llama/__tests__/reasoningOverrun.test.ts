import { describe, expect, it } from 'vitest'
import { defaultThoughtTokenBudget } from '../localOutputBudget'
import {
  MAX_REASONING_OVERRUNS,
  REASONING_OVERRUN_GUIDANCE,
  reasoningBudgetChars
} from '../reasoningOverrun'

describe('reasoningBudgetChars', () => {
  it('gives the llama-server path the same share of the cap the text path budgets', () => {
    // The whole point of the module: one policy, two enforcement mechanisms.
    // If these drift, a model gets a different amount of room to think in
    // purely because its GGUF carries a projector.
    for (const cap of [512, 2_048, 8_192, 15_875, 32_768]) {
      expect(reasoningBudgetChars(cap)).toBe(defaultThoughtTokenBudget(cap) * 4)
    }
  })

  it('leaves most of the cap for the reply that has to follow the reasoning', () => {
    // 15,875 is the measured cap from the conversation that motivated this.
    // The budget must be well under it or the round still cannot act.
    const budget = reasoningBudgetChars(15_875)
    expect(budget).not.toBeNull()
    expect(budget!).toBeLessThan(15_875 * 4 * 0.5)
    // …and comfortably above the 75,715 characters that round actually spent,
    // is exactly what it must NOT be.
    expect(budget!).toBeLessThan(75_715)
  })

  it('applies no cap when there is no meaningful output ceiling to size against', () => {
    // An unmeasured or nonsensical ceiling must not become a tiny budget that
    // cuts off every round's first sentence.
    expect(reasoningBudgetChars(0)).toBeNull()
    expect(reasoningBudgetChars(-1)).toBeNull()
    expect(reasoningBudgetChars(Number.NaN)).toBeNull()
    expect(reasoningBudgetChars(Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('scales with the cap rather than being a fixed number of characters', () => {
    const small = reasoningBudgetChars(2_048)
    const large = reasoningBudgetChars(32_768)
    expect(small).not.toBeNull()
    expect(large).not.toBeNull()
    expect(large!).toBeGreaterThan(small!)
  })
})

describe('REASONING_OVERRUN_GUIDANCE', () => {
  it('tells the model to act on what it has rather than restart', () => {
    // Restarting is the observed behaviour this text exists to prevent — it is
    // what produced the same opening sentence and the same two reads twice in
    // one reply.
    expect(REASONING_OVERRUN_GUIDANCE).toContain('do not start over')
    expect(REASONING_OVERRUN_GUIDANCE).toMatch(/next tool call/i)
  })
})

describe('MAX_REASONING_OVERRUNS', () => {
  it('is finite, so a model that only ever thinks cannot spend the whole turn', () => {
    expect(MAX_REASONING_OVERRUNS).toBeGreaterThan(0)
    expect(MAX_REASONING_OVERRUNS).toBeLessThanOrEqual(3)
  })
})
