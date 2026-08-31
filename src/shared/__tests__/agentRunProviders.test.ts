import { describe, expect, it } from 'vitest'
import type { ProviderSettings } from '../settings.types'
import {
  AGENT_RUN_PROVIDER_IDS,
  agentRunProviderOptions,
  defaultAgentRunModel,
  seedAgentRunProvider
} from '../agentRunProviders'

/**
 * Agent runs used to accept only `local | anthropic | openai` while chat
 * accepted twelve providers, so a DeepSeek key could be configured, shown as
 * connected, and still be unusable for a Workspace run. Worse, the run editor
 * resolved any other globally-active provider to `local` — a run the user
 * believed was on DeepSeek quietly executed on whatever local model happened to
 * be loaded, with nothing on screen saying so.
 *
 * These tests pin the two halves of that: every provider chat can use is
 * offerable to a run, and a configured provider is never silently downgraded.
 */

/** A settings object with no provider configured, to be extended per test. */
function settings(overrides: Partial<ProviderSettings> = {}): ProviderSettings {
  const cloud = { apiKey: '', model: '', dailyTokenCap: null, maxResponseTokens: null }
  return {
    active: 'local',
    local: { maxResponseTokens: null, recallWindowFraction: null },
    anthropic: { ...cloud, model: 'claude-sonnet-5' },
    openai: { ...cloud, model: 'gpt-5.1-codex' },
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
}

describe('agent run providers', () => {
  it('covers every provider chat can use', () => {
    // The union chat accepts, written out so widening one and not the other
    // fails here rather than silently stranding a provider in agent mode.
    const chatProviders: ProviderSettings['active'][] = [
      'local',
      'anthropic',
      'openai',
      'google',
      'xai',
      'deepseek',
      'mistral',
      'groq',
      'openrouter',
      'azure',
      'kimi',
      'qwen'
    ]
    expect([...AGENT_RUN_PROVIDER_IDS].sort()).toEqual([...chatProviders].sort())
  })

  it('offers only providers this install can authenticate as', () => {
    const options = agentRunProviderOptions(settings())
    expect(options.map((option) => option.value)).toEqual(['local'])
  })

  it('offers a cloud provider once its key is set', () => {
    const options = agentRunProviderOptions(
      settings({
        deepseek: { apiKey: 'sk-test', model: '', dailyTokenCap: null, maxResponseTokens: null }
      })
    )
    expect(options.map((option) => option.value)).toContain('deepseek')
    expect(options.find((option) => option.value === 'deepseek')?.label).toBe('DeepSeek')
  })

  it('does not offer Azure until its deployment is named, not merely keyed', () => {
    // Azure needs a resource and a deployment as well as a key; a key alone
    // produces a run that fails on its first turn.
    const keyOnly = agentRunProviderOptions(
      settings({
        azure: {
          apiKey: 'k',
          resourceName: '',
          deploymentName: '',
          apiVersion: '2024-10-21',
          dailyTokenCap: null,
          maxResponseTokens: null
        }
      })
    )
    expect(keyOnly.map((option) => option.value)).not.toContain('azure')

    const complete = agentRunProviderOptions(
      settings({
        azure: {
          apiKey: 'k',
          resourceName: 'res',
          deploymentName: 'dep',
          apiVersion: '2024-10-21',
          dailyTokenCap: null,
          maxResponseTokens: null
        }
      })
    )
    expect(complete.map((option) => option.value)).toContain('azure')
  })

  it('seeds a run with the globally active provider rather than downgrading it', () => {
    const configured = settings({
      active: 'deepseek',
      deepseek: { apiKey: 'sk-test', model: '', dailyTokenCap: null, maxResponseTokens: null }
    })
    expect(seedAgentRunProvider(configured, undefined)).toBe('deepseek')
  })

  it('falls back to local only when the active provider cannot authenticate', () => {
    // A key cleared in Settings leaves `active` pointing at a provider this
    // install can no longer use; local is the honest answer there.
    const stranded = settings({ active: 'deepseek' })
    expect(seedAgentRunProvider(stranded, undefined)).toBe('local')
  })

  it('prefers a retry seed over the active provider, when still usable', () => {
    const configured = settings({
      active: 'deepseek',
      deepseek: { apiKey: 'sk-test', model: '', dailyTokenCap: null, maxResponseTokens: null },
      groq: { apiKey: 'gsk', model: '', dailyTokenCap: null, maxResponseTokens: null }
    })
    expect(seedAgentRunProvider(configured, 'groq')).toBe('groq')
    // A seed whose key has since been removed must not be honoured.
    expect(seedAgentRunProvider(configured, 'kimi')).toBe('deepseek')
  })

  it('defaults a run model from the provider catalog', () => {
    expect(defaultAgentRunModel(settings(), 'deepseek')).toBe('deepseek-v4-flash')
    // A model the user chose in Settings wins over the catalog default.
    const chosen = settings({
      deepseek: {
        apiKey: 'sk',
        model: 'deepseek-v4-pro',
        dailyTokenCap: null,
        maxResponseTokens: null
      }
    })
    expect(defaultAgentRunModel(chosen, 'deepseek')).toBe('deepseek-v4-pro')
  })

  it('has no model id for a local run', () => {
    // Local always uses whatever model is loaded; a model id here would be a lie.
    expect(defaultAgentRunModel(settings(), 'local')).toBe('')
  })

  it('uses the deployment name as Azure model id', () => {
    const azure = settings({
      azure: {
        apiKey: 'k',
        resourceName: 'res',
        deploymentName: 'my-deployment',
        apiVersion: '2024-10-21',
        dailyTokenCap: null,
        maxResponseTokens: null
      }
    })
    expect(defaultAgentRunModel(azure, 'azure')).toBe('my-deployment')
  })
})
