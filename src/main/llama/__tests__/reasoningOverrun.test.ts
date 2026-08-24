import { describe, expect, it } from 'vitest'
import { defaultThoughtTokenBudget, minimumViableOutputTokens } from '../localOutputBudget'
import {
  MAX_REASONING_OVERRUNS,
  REASONING_BUDGET_MESSAGE,
  reasoningBudgetTokens,
  reasoningOverrunGuidance
} from '../reasoningOverrun'

describe('reasoningBudgetTokens', () => {
  /**
   * The invariant the whole fix rests on, and the one the live probe caught
   * being violated: a budget above the round's own cap never engages. Three
   * consecutive rounds then spent their entire allowance thinking and produced
   * nothing, for 30 minutes. Every window must leave real room for the call.
   */
  it('binds on the tightest round the transport will still issue', () => {
    for (const contextSize of [4_096, 8_192, 16_384, 32_768, 131_072]) {
      const floor = minimumViableOutputTokens(contextSize, true)
      const budget = reasoningBudgetTokens(contextSize)!
      expect(budget).toBeLessThan(floor)
      // And not merely under it — what is left has to fit a whole tool call.
      expect(floor - budget).toBeGreaterThanOrEqual(budget)
    }
  })

  it('gives the llama-server path the same share the text path budgets', () => {
    // One policy, two enforcement mechanisms. If these drift, a model gets a
    // different amount of room to think in purely because its GGUF carries a
    // projector.
    for (const contextSize of [16_384, 32_768, 131_072]) {
      expect(reasoningBudgetTokens(contextSize)).toBe(
        defaultThoughtTokenBudget(minimumViableOutputTokens(contextSize, true))
      )
    }
  })

  it('stays far below the runaway it exists to bound', () => {
    // The measured pathology was ~19,000 tokens of reasoning in one segment,
    // against a round allowance of 15,875.
    expect(reasoningBudgetTokens(32_768)!).toBeLessThan(19_000 / 10)
  })

  it('never collapses to a budget that would cut off a first sentence', () => {
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

  it('grows with the window until the floor it tracks stops growing', () => {
    // `minimumViableOutputTokens` is capped at 2,048, so past roughly 17K the
    // tightest round stops getting tighter and neither does this.
    expect(reasoningBudgetTokens(32_768)!).toBeGreaterThan(reasoningBudgetTokens(8_192)!)
    expect(reasoningBudgetTokens(131_072)).toBe(reasoningBudgetTokens(32_768))
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

describe('REASONING_BUDGET_MESSAGE', () => {
  /**
   * The regression it exists to stop, measured on Qwen3.8-27B at a 16K window
   * once the budget shipped without it: hidden reasoning was correctly held to
   * ~800 tokens and the reply then carried 13,578- and 9,129-character visible
   * blocks of "Wait, there's a subtlety..." — the budget had relocated the
   * reasoning into the chat rather than ended it. With this message the same
   * round's visible text fell from 3,322 characters to 247, and those 247 were
   * the one-sentence narration the system prompt asks for.
   */
  it("reads as the model's own closing thought, not an instruction to it", () => {
    // It is appended inside the model's thought and read back as the last thing
    // it decided. Second person there reads as dialogue to answer — one more
    // thing to say instead of an action.
    expect(REASONING_BUDGET_MESSAGE).toMatch(/^I have used/)
    expect(REASONING_BUDGET_MESSAGE).not.toMatch(/\byou\b/i)
  })

  it('points at the next tool call rather than just declaring the budget spent', () => {
    expect(REASONING_BUDGET_MESSAGE).toMatch(/tool call/i)
  })
})

describe('MAX_REASONING_OVERRUNS', () => {
  it('is finite, so a model that only ever thinks cannot spend the whole turn', () => {
    expect(MAX_REASONING_OVERRUNS).toBeGreaterThan(0)
    expect(MAX_REASONING_OVERRUNS).toBeLessThanOrEqual(3)
  })
})
