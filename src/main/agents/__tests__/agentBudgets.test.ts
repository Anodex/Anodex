import { describe, expect, it } from 'vitest'
import { budgetExceededReason } from '../agentBudgets'

function run(overrides: { maxTokens?: number; maxDurationMinutes?: number } = {}) {
  return {
    maxTokens: overrides.maxTokens ?? 50_000,
    maxDurationMinutes: overrides.maxDurationMinutes ?? 30,
    createdAt: 0
  }
}

describe('budgetExceededReason', () => {
  it('returns null when under both budgets', () => {
    expect(budgetExceededReason(run(), 1000, 60_000)).toBeNull()
  })

  it('returns a token-budget reason once tokens used reach the cap', () => {
    const reason = budgetExceededReason(run({ maxTokens: 5000 }), 5000, 1000)
    expect(reason).toContain('token budget')
    expect(reason).toContain('5,000')
  })

  it('returns a time-budget reason once elapsed time reaches the cap', () => {
    const reason = budgetExceededReason(run({ maxDurationMinutes: 10 }), 100, 10 * 60_000)
    expect(reason).toContain('10-minute time budget')
  })

  it('checks the token budget before the time budget when both are exceeded', () => {
    const reason = budgetExceededReason(
      run({ maxTokens: 100, maxDurationMinutes: 1 }),
      100,
      2 * 60_000
    )
    expect(reason).toContain('token budget')
  })

  it('treats usage strictly above the cap as exceeded too', () => {
    expect(budgetExceededReason(run({ maxTokens: 100 }), 150, 0)).toContain('token budget')
  })
})
