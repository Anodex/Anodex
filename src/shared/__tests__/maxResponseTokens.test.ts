import { describe, expect, it } from 'vitest'
import type { AppSettings } from '../settings.types'
import { createDefaultSettings } from '../settings.defaults'
import { activeMaxResponseTokens, providerMaxResponseTokens } from '../maxResponseTokens'

function settings(overrides: (draft: AppSettings) => void): AppSettings {
  const value = createDefaultSettings('C:\\models')
  overrides(value)
  return value
}

describe('activeMaxResponseTokens', () => {
  it('is off for the local engine by default', () => {
    const value = settings(() => {})

    expect(value.provider.active).toBe('local')
    expect(value.provider.local.maxResponseTokens).toBeNull()
    expect(activeMaxResponseTokens(value)).toBeUndefined()
  })

  it('honours a ceiling the user turned on for the local engine', () => {
    const value = settings((draft) => {
      draft.provider.local.maxResponseTokens = 4096
    })

    expect(activeMaxResponseTokens(value)).toBe(4096)
  })

  it('reads only the provider actually handling the turn', () => {
    // The bug this shape replaced: one global number capped every backend, so
    // a ceiling chosen to bound cloud spend also truncated local replies.
    const value = settings((draft) => {
      draft.provider.active = 'local'
      draft.provider.anthropic.maxResponseTokens = 1024
    })

    expect(activeMaxResponseTokens(value)).toBeUndefined()

    value.provider.active = 'anthropic'
    expect(activeMaxResponseTokens(value)).toBe(1024)
  })

  it('treats a non-positive or missing value as no ceiling', () => {
    const value = settings((draft) => {
      draft.provider.openai.maxResponseTokens = 0
    })

    expect(providerMaxResponseTokens(value.provider, 'openai')).toBeUndefined()
  })
})
