import { describe, expect, it, vi } from 'vitest'
import {
  GenerationBudget,
  interactiveBudgetForContext,
  turnTimeLimitOverride
} from '../GenerationBudget'

describe('GenerationBudget', () => {
  it('scales local context-shift tolerance with the configured context window', () => {
    expect(interactiveBudgetForContext(4_096).maxContextShifts).toBe(4)
    expect(interactiveBudgetForContext(8_192).maxContextShifts).toBe(8)
    expect(interactiveBudgetForContext(32_768).maxContextShifts).toBe(12)
  })

  it('derives the per-turn wall-clock cap from the configured minutes, or disables it when null', () => {
    expect(turnTimeLimitOverride(15).maxDurationMs).toBe(15 * 60_000)
    expect(turnTimeLimitOverride(null).maxDurationMs).toBeNull()
    expect(interactiveBudgetForContext(8_192, 5).maxDurationMs).toBe(5 * 60_000)
    expect(interactiveBudgetForContext(8_192, null).maxDurationMs).toBeNull()
  })

  it('never times out when the wall-clock cap is disabled', () => {
    vi.useFakeTimers()
    const budget = new GenerationBudget({
      maxDurationMs: null,
      maxTools: 1,
      maxProviderRounds: 1,
      maxContextShifts: 1
    })
    vi.advanceTimersByTime(365 * 24 * 60 * 60_000)
    expect(budget.stopReason).toBeUndefined()
    expect(budget.signal.aborted).toBe(false)
    budget.dispose()
    vi.useRealTimers()
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
    expect(budget.signal.aborted).toBe(false)
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
    expect(budget.stopReason).toBe('context-shift-limit')
    expect(budget.signal.aborted).toBe(true)
    budget.dispose()
  })

  it('allows a hard timeout to override a soft tool limit', () => {
    vi.useFakeTimers()
    const budget = new GenerationBudget({
      maxDurationMs: 100,
      maxTools: 0,
      maxProviderRounds: 1,
      maxContextShifts: 1
    })
    expect(budget.beforeTool()).toContain('tool-call budget')
    vi.advanceTimersByTime(100)
    expect(budget.stopReason).toBe('time-limit')
    expect(budget.signal.aborted).toBe(true)
    budget.dispose()
    vi.useRealTimers()
  })
})
