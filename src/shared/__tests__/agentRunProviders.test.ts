import { describe, expect, it } from 'vitest'
import type { ProviderSettings } from '../settings.types'
import {
  AGENT_RUN_PROVIDER_IDS,
  agentRunProviderOptions,
  agentRunContextSize,
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

/**
 * The turn budget scales with the window a run actually has: a turn at 8,192
 * holds a fraction of what one at 65,536 does, so a small window is given more
 * turns to finish the same work.
 *
 * Both the run editor and `AgentRunStore` sized that from
 * `settings.lastModelPath` — the local `.gguf` — no matter which provider the
 * run used. `AgentRunStore.runContextSize` even documented the intended
 * behaviour ("Undefined for a cloud provider") that its body did not implement.
 *
 * The consequence is worst where it is least visible: with a small local model
 * last loaded, a DeepSeek run was offered a ceiling of 543 turns sized for an
 * 8,192-token window, against a model whose window is 1,048,576 — and every one
 * of those turns is billed.
 */
describe('agent run context size', () => {
  const local = {
    model: { contextSize: 8192 },
    modelContextSizes: {},
    lastModelPath: 'C:/models/small.gguf'
  } as Parameters<typeof agentRunContextSize>[0]

  it('uses the loaded local model window for a local run', () => {
    expect(agentRunContextSize(local, 'local', null)).toBe(8192)
  })

  it('does not size a cloud run from the local model', () => {
    expect(agentRunContextSize(local, 'deepseek', 'deepseek-v4-flash')).not.toBe(8192)
  })

  it('uses the cloud model own window', () => {
    expect(agentRunContextSize(local, 'deepseek', 'deepseek-v4-flash')).toBe(1_048_576)
  })

  it('falls back to the conservative cloud default for an unknown model', () => {
    // A live-fetched id newer than the bundled catalog, or an Azure deployment
    // the customer named: bounded rather than unbounded.
    expect(agentRunContextSize(local, 'azure', 'my-deployment')).toBe(128_000)
    expect(agentRunContextSize(local, 'openai', 'some-unreleased-model')).toBe(128_000)
  })
})
