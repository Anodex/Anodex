import { describe, expect, it, vi } from 'vitest'
import { GenerationBudget, interactiveBudgetForContext } from '../GenerationBudget'

describe('GenerationBudget', () => {
  it('scales local context-shift tolerance with the configured context window', () => {
    expect(interactiveBudgetForContext(4_096).maxContextShifts).toBe(2)
    expect(interactiveBudgetForContext(8_192).maxContextShifts).toBe(4)
    expect(interactiveBudgetForContext(32_768).maxContextShifts).toBe(12)
  })

  it('blocks new work after the tool budget without mislabeling a user stop', () => {
    const budget = new GenerationBudget({
      maxDurationMs: 60_000,
      maxTools: 1,
      maxProviderRounds: 1,
      maxContextShifts: 1
    })
    expect(budget.beforeTool()).toBeNull()
    expect(budget.beforeTool()).toContain('tool-call budget')
    expect(budget.stopReason).toBe('tool-limit')
    budget.dispose()
  })

  it('reports an outer abort as a user stop', () => {
    const outer = new AbortController()
    const budget = new GenerationBudget(
      { maxDurationMs: 60_000, maxTools: 1, maxProviderRounds: 1, maxContextShifts: 1 },
      outer.signal
    )
    outer.abort()
    expect(budget.stopReason).toBe('user')
    budget.dispose(outer.signal)
  })

  it('enforces the wall-clock budget', () => {
    vi.useFakeTimers()
    const budget = new GenerationBudget({
      maxDurationMs: 100,
      maxTools: 1,
      maxProviderRounds: 1,
      maxContextShifts: 1
    })
    vi.advanceTimersByTime(100)
    expect(budget.stopReason).toBe('time-limit')
    budget.dispose()
    vi.useRealTimers()
  })

  it('stops after the configured number of context shifts', () => {
    const budget = new GenerationBudget({
      maxDurationMs: 60_000,
      maxTools: 1,
      maxProviderRounds: 1,
      maxContextShifts: 1
    })
    budget.recordContextShift()
    expect(budget.stopReason).toBeUndefined()
    budget.recordContextShift()
    expect(budget.stopReason).toBe('context-limit')
    budget.dispose()
  })
})
