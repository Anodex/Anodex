import { describe, expect, it } from 'vitest'
import { budgetExceededReason, turnBudgetLeftovers } from '../agentBudgets'

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

describe('turnBudgetLeftovers', () => {
  const run = { maxTokens: 300_000, maxDurationMinutes: 120 }

  it('names what a turn-exhausted run still had, so a mis-sized cap is visible', () => {
    // The measured case: an 8K run stopped at 25/25 turns having completed 0 of
    // 4 plan steps, with 28 tool calls, zero failures, and 1.9% of its tokens
    // spent. It read as a model that achieved nothing.
    const message = turnBudgetLeftovers(run, 5_668, 10 * 60_000)

    expect(message).toContain('5,668')
    expect(message).toContain('300,000')
    expect(message).toContain('10 of 120 minutes')
    expect(message).toContain('raising the turn limit')
  })

  it('reports under 1% as "<1" rather than rounding it away to zero', () => {
    expect(turnBudgetLeftovers(run, 900, 60_000)).toContain('(<1%)')
  })

  it('says nothing about raising the limit when the budget was genuinely spent', () => {
    // A run that used most of its tokens hit a real ceiling; telling it to ask
    // for more turns would be advice pointing at the wrong constraint.
    const message = turnBudgetLeftovers(run, 250_000, 100 * 60_000)

    expect(message).toContain('250,000')
    expect(message).not.toContain('raising the turn limit')
  })

  it('does not divide by a zero token budget', () => {
    expect(() => turnBudgetLeftovers({ maxTokens: 0, maxDurationMinutes: 1 }, 0, 0)).not.toThrow()
  })
})
