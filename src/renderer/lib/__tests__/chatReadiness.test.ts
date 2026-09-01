import { describe, expect, it } from 'vitest'
import type { AppSettings, ProviderSettings } from '@shared/settings.types'
import { isChatReady } from '../chatReadiness'

/**
 * `isChatReady` gates the composer. It used to name Anthropic and OpenAI and
 * fall through to `engineStatus === 'ready'` for everything else — so a user
 * chatting on DeepSeek, Google, Groq or any of the other six was told to load a
 * local model before they could send anything, which is precisely the state its
 * own docstring says it exists to prevent.
 *
 * A cloud provider needs a key, not a loaded model. Only `local` needs an
 * engine.
 */
function settings(
  active: ProviderSettings['active'],
  overrides: Partial<ProviderSettings> = {}
): AppSettings {
  const cloud = { apiKey: '', model: '', dailyTokenCap: null, maxResponseTokens: null }
  return {
    provider: {
      active,
      local: { maxResponseTokens: null, recallWindowFraction: null },
      anthropic: { ...cloud, model: 'claude-sonnet-5' },
      openai: { ...cloud, model: 'gpt-5.6' },
      google: { ...cloud },
      xai: { ...cloud },
      deepseek: { ...cloud },
      mistral: { ...cloud },
      groq: { ...cloud },
      openrouter: { ...cloud },
      azure: {
        apiKey: '',
        resourceName: '',
        deploymentName: '',
        apiVersion: '2024-10-21',
        dailyTokenCap: null,
        maxResponseTokens: null
      },
      kimi: { ...cloud },
      qwen: { ...cloud },
      ...overrides
    }
  } as AppSettings
}

const keyed = { apiKey: 'sk-test', model: '', dailyTokenCap: null, maxResponseTokens: null }

describe('isChatReady', () => {
  it('needs a loaded engine for a local chat', () => {
    expect(isChatReady(settings('local'), 'ready')).toBe(true)
    expect(isChatReady(settings('local'), 'unloaded')).toBe(false)
  })

  it('needs only a key for Anthropic and OpenAI', () => {
    expect(isChatReady(settings('anthropic', { anthropic: { ...keyed } }), 'unloaded')).toBe(true)
    expect(isChatReady(settings('openai', { openai: { ...keyed } }), 'unloaded')).toBe(true)
  })

  it('does not require a local model for any other cloud provider', () => {
    // The bug: these all fell through to `engineStatus === 'ready'`, so the
    // composer stayed blocked with no local model loaded.
    for (const id of [
      'deepseek',
      'google',
      'xai',
      'mistral',
      'groq',
      'openrouter',
      'kimi',
      'qwen'
    ] as const) {
      expect(isChatReady(settings(id, { [id]: { ...keyed } }), 'unloaded')).toBe(true)
    }
  })

  it('is not ready for a cloud provider with no key', () => {
    expect(isChatReady(settings('deepseek'), 'unloaded')).toBe(false)
    // Even a loaded local engine does not make an unkeyed cloud provider ready.
    expect(isChatReady(settings('deepseek'), 'ready')).toBe(false)
  })

  it('needs a full Azure configuration, not a key alone', () => {
    const keyOnly = settings('azure', {
      azure: {
        apiKey: 'k',
        resourceName: '',
        deploymentName: '',
        apiVersion: '2024-10-21',
        dailyTokenCap: null,
        maxResponseTokens: null
      }
    })
    expect(isChatReady(keyOnly, 'unloaded')).toBe(false)

    const complete = settings('azure', {
      azure: {
        apiKey: 'k',
        resourceName: 'res',
        deploymentName: 'dep',
        apiVersion: '2024-10-21',
        dailyTokenCap: null,
        maxResponseTokens: null
      }
    })
    expect(isChatReady(complete, 'unloaded')).toBe(true)
  })

  it('is not ready with no settings at all', () => {
    expect(isChatReady(null, 'unloaded')).toBe(false)
  })
})
