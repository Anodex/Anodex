import { describe, expect, it } from 'vitest'
import { dailyCapReached, dailyCapRefusal } from '../dailyCap'

describe('dailyCapReached', () => {
  it('does nothing while the policy is warn-only', () => {
    // The default, and what everyone who already set a cap is expecting.
    expect(dailyCapReached({ todayTokens: 9_999, cap: 100, stopAtCap: false })).toBe(false)
  })

  it('refuses at the cap, not one send past it', () => {
    expect(dailyCapReached({ todayTokens: 99, cap: 100, stopAtCap: true })).toBe(false)
    expect(dailyCapReached({ todayTokens: 100, cap: 100, stopAtCap: true })).toBe(true)
    expect(dailyCapReached({ todayTokens: 101, cap: 100, stopAtCap: true })).toBe(true)
  })

  it('treats no cap as no limit', () => {
    expect(dailyCapReached({ todayTokens: 1e9, cap: null, stopAtCap: true })).toBe(false)
  })

  it('lets a cap of zero mean zero', () => {
    // A legitimate way to switch a provider off for the day.
    expect(dailyCapReached({ todayTokens: 0, cap: 0, stopAtCap: true })).toBe(true)
  })

  it('ignores a corrupt cap rather than refusing everything', () => {
    // Refusing every send because a settings value went bad would read as the
    // provider being broken, and the user would have no way to tell.
    expect(dailyCapReached({ todayTokens: 5, cap: Number.NaN, stopAtCap: true })).toBe(false)
    expect(
      dailyCapReached({ todayTokens: 5, cap: Number.POSITIVE_INFINITY, stopAtCap: true })
    ).toBe(false)
    expect(dailyCapReached({ todayTokens: 5, cap: -1, stopAtCap: true })).toBe(false)
  })
})

describe('dailyCapRefusal', () => {
  it('names both numbers, because both are needed to decide what to do', () => {
    const message = dailyCapRefusal('DeepSeek', {
      todayTokens: 1_250_000,
      cap: 1_000_000,
      stopAtCap: true
    })
    expect(message).toContain('DeepSeek')
    expect(message).toContain('1,250,000')
    expect(message).toContain('1,000,000')
  })

  it('says the count is Anodex’s own, not the provider’s', () => {
    // Otherwise someone comparing it with a billing page concludes one of
    // them is lying.
    const message = dailyCapRefusal('OpenAI', { todayTokens: 10, cap: 5, stopAtCap: true })
    expect(message).toMatch(/counts what it sends/i)
  })

  it('offers the three things that actually resolve it', () => {
    const message = dailyCapRefusal('OpenAI', { todayTokens: 10, cap: 5, stopAtCap: true })
    expect(message).toMatch(/raise the cap/i)
    expect(message).toMatch(/switch provider/i)
    expect(message).toMatch(/midnight/i)
  })
})
