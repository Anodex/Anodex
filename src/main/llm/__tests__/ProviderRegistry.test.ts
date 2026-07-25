import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activeProvider: 'local'
}))

vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: {
    get: () => ({ provider: { active: mocks.activeProvider } })
  }
}))

vi.mock('../../llama/LlamaService', () => ({
  llamaService: { id: 'local', generate: vi.fn() }
}))

vi.mock('../AnthropicProvider', () => ({
  anthropicProvider: { id: 'anthropic', generate: vi.fn() }
}))

vi.mock('../OpenAiProvider', () => ({
  openAiProvider: { id: 'openai', generate: vi.fn() }
}))

vi.mock('../AzureOpenAiProvider', () => ({
  azureOpenAiProvider: { id: 'azure', generate: vi.fn() }
}))

vi.mock('../cloudProviderConfigs', () => ({
  openAiCompatibleProviders: {
    google: { id: 'google', generate: vi.fn() },
    xai: { id: 'xai', generate: vi.fn() },
    deepseek: { id: 'deepseek', generate: vi.fn() },
    mistral: { id: 'mistral', generate: vi.fn() },
    groq: { id: 'groq', generate: vi.fn() },
    openrouter: { id: 'openrouter', generate: vi.fn() },
    kimi: { id: 'kimi', generate: vi.fn() },
    qwen: { id: 'qwen', generate: vi.fn() }
  }
}))

const { getActiveProvider } = await import('../ProviderRegistry')

describe('getActiveProvider', () => {
  it('uses the global setting when no override is given', () => {
    mocks.activeProvider = 'anthropic'
    expect(getActiveProvider().id).toBe('anthropic')
  })

  it('uses the override instead of the global setting when given', () => {
    mocks.activeProvider = 'local'
    expect(getActiveProvider('openai').id).toBe('openai')
  })

  it('never mutates the global setting when overridden', () => {
    mocks.activeProvider = 'local'
    getActiveProvider('anthropic')
    expect(getActiveProvider().id).toBe('local')
  })

  it('falls back to local for an unrecognized override id', () => {
    // @ts-expect-error deliberately invalid to exercise the fallback
    expect(getActiveProvider('not-a-real-provider').id).toBe('local')
  })

  it.each([
    'google',
    'xai',
    'deepseek',
    'mistral',
    'groq',
    'openrouter',
    'azure',
    'kimi',
    'qwen'
  ] as const)('routes to the %s provider when overridden', (id) => {
    expect(getActiveProvider(id).id).toBe(id)
  })
})
