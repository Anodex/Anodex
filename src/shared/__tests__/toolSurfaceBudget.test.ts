import { describe, expect, it } from 'vitest'
import { allocateContextBudget, toolSurfaceBudgetTokens } from '../contextBudget'

/**
 * The tool surface must not be allowed to eat the conversation.
 *
 * `LlamaService` computed this budget itself as "the window, minus a shift
 * reserve, minus the output reserve, minus a tool-result headroom" — three
 * subtractions, none of them for history. At 8,192 tokens that permitted 4,917
 * for fixed cost, sixty percent of the window, and the working set was
 * whatever happened to survive.
 *
 * Measured: an email conversation at 8K reached `fixedTokens: 4096`, spent 879
 * seconds on turn two, and returned zero characters on turn three with
 * `stop=context-shift-limit` — an empty reply. Four models, same failure,
 * including the 27B that scores 10/10 on the chat matrix at that window.
 *
 * The window sizes below are the ones people actually run: 4K and 8K are
 * common local configurations, and 8K is where the failure was measured.
 */
const WINDOWS = [4096, 8192, 16384, 32768, 65536]

describe('toolSurfaceBudgetTokens', () => {
  it.each(WINDOWS)('leaves the whole working set alone at %i', (contextSize) => {
    // The point of the change. Fixed cost plus the reply plus the working set
    // is the entire window, so a fixed budget that respects the allocation
    // cannot be spending history's room.
    const allocation = allocateContextBudget(contextSize)
    const budget = toolSurfaceBudgetTokens(contextSize)
    expect(budget + allocation.outputReserve + allocation.workingSet).toBeLessThanOrEqual(
      contextSize
    )
  })

  it.each(WINDOWS)('stays well under the old sixty-percent allowance at %i', (contextSize) => {
    const previous = Math.max(
      0,
      contextSize -
        Math.max(1, Math.floor(contextSize / 10)) -
        allocateContextBudget(contextSize).outputReserve -
        Math.max(512, Math.min(3000, Math.floor(contextSize * 0.15)))
    )
    expect(toolSurfaceBudgetTokens(contextSize)).toBeLessThan(previous)
  })

  it.each(WINDOWS)('still gives the surface a usable share at %i', (contextSize) => {
    // The failure mode in the other direction: a budget so tight that nothing
    // is natively described and every call pays three gateway round trips.
    expect(toolSurfaceBudgetTokens(contextSize) / contextSize).toBeGreaterThan(0.2)
  })

  it('grows with the window rather than being a flat cap', () => {
    const budgets = WINDOWS.map(toolSurfaceBudgetTokens)
    for (let index = 1; index < budgets.length; index++) {
      expect(budgets[index]).toBeGreaterThan(budgets[index - 1])
    }
  })

  it('is exactly the system prompt and schema budgets, not a rule of its own', () => {
    // Four call sites already read the allocation so they cannot disagree;
    // this one had its own arithmetic, which is how it drifted.
    const allocation = allocateContextBudget(8192)
    expect(toolSurfaceBudgetTokens(8192)).toBe(allocation.referenceContext + allocation.toolSchemas)
  })

  it('returns something sane for a window too small to hold its floors', () => {
    // `allocateContextBudget` scales the soft budgets back when they do not
    // fit; the caller must still get a non-negative number it can measure
    // against rather than a negative one that defers every tool.
    expect(toolSurfaceBudgetTokens(1024)).toBeGreaterThanOrEqual(0)
    expect(toolSurfaceBudgetTokens(0)).toBeGreaterThanOrEqual(0)
  })
})
