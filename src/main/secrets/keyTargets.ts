import { CLOUD_PROVIDER_LABELS, type CloudProviderId } from '@shared/providerCatalog'
import { DEFAULT_ANTHROPIC_MODEL } from '@shared/anthropicModels'
import { DEFAULT_OPENAI_MODEL } from '@shared/openaiModels'
import { settingsStore } from '../settings/SettingsStore'
import { testSearchProvider } from '../tools/search/testSearchProvider'
import { verifyAnthropicKey } from '../llm/AnthropicProvider'
import { verifyOpenAiKey } from '../llm/OpenAiProvider'
import { verifyOpenAiCompatibleKey } from '../llm/OpenAiCompatibleProvider'
import { OPEN_AI_COMPATIBLE_CONFIGS } from '../llm/cloudProviderConfigs'
import { githubService } from '../github/GitHubService'

/** Somewhere Anodex can keep a key the person gives it, and how to check one works. */
export interface KeyTarget {
  id: string
  /** What the person calls it: "Tavily", "OpenAI", "GitHub". */
  name: string
  /** Where to get one, when there is a stable page for it. */
  getUrl?: string
  placeholder: string
  /**
   * Check the key really works, then store it encrypted in its setting.
   * Resolves with a line to tell the model (never the key); throws with the
   * service's own reason when the key is refused, and stores nothing.
   */
  checkAndSave(key: string): Promise<string>
}

/** Cloud providers that take a single API key. Azure needs a resource and a deployment too. */
type KeyedProvider = Exclude<CloudProviderId, 'azure'>

const PROVIDER_KEY_PAGES: Partial<Record<KeyedProvider, string>> = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  google: 'https://aistudio.google.com/apikey',
  groq: 'https://console.groq.com/keys',
  openrouter: 'https://openrouter.ai/keys',
  mistral: 'https://console.mistral.ai/api-keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  xai: 'https://console.x.ai'
}

function searchTarget(
  id: 'tavily' | 'brave',
  name: string,
  getUrl: string,
  placeholder: string
): KeyTarget {
  return {
    id,
    name,
    getUrl,
    placeholder,
    async checkAndSave(key) {
      const results = await testSearchProvider({
        provider: id,
        apiKey: key,
        baseUrl: settingsStore.get().webSearch.baseUrl,
        searchEngineId: ''
      })
      settingsStore.update({ webSearch: { provider: id, apiKey: key } })
      return `${name} key saved and working (a test search returned ${results} results). Web search now uses ${name}.`
    }
  }
}

function providerTarget(id: KeyedProvider): KeyTarget {
  const name = CLOUD_PROVIDER_LABELS[id]
  return {
    id,
    name,
    getUrl: PROVIDER_KEY_PAGES[id],
    placeholder: `${name} API key`,
    async checkAndSave(key) {
      const configured = settingsStore.get().provider[id]
      // Checked against the chosen model, or the provider's default when none
      // has been chosen yet: the check asks whether the model is reachable.
      const chosen = ('model' in configured ? configured.model : '').trim()
      if (id === 'anthropic') await verifyAnthropicKey(key, chosen || DEFAULT_ANTHROPIC_MODEL)
      else if (id === 'openai') await verifyOpenAiKey(key, chosen || DEFAULT_OPENAI_MODEL)
      else {
        const config = OPEN_AI_COMPATIBLE_CONFIGS[id]
        await verifyOpenAiCompatibleKey(config, key, chosen || config.defaultModel)
      }
      settingsStore.update({ provider: { [id]: { apiKey: key } } })
      return `${name} key saved and working. It can be chosen in Settings → AI & Models; the active model was not changed.`
    }
  }
}

const GITHUB: KeyTarget = {
  id: 'github',
  name: 'GitHub',
  getUrl: 'https://github.com/settings/personal-access-tokens',
  placeholder: 'github_pat_…',
  async checkAndSave(key) {
    const before = await githubService.getState()
    const state = await githubService.connect({
      token: key,
      readOnly: before.configured ? before.readOnly : false,
      toolsets: before.configured ? before.toolsets : []
    })
    if (!state.connected) {
      throw new Error(state.error ?? 'GitHub did not accept that token.')
    }
    return `GitHub connected${state.account ? ` as @${state.account.login}` : ''}.`
  }
}

/** Every service a key can be given for, by the id the tools take. */
export const KEY_TARGETS: readonly KeyTarget[] = [
  searchTarget('tavily', 'Tavily', 'https://app.tavily.com/', 'tvly-…'),
  searchTarget(
    'brave',
    'Brave Search',
    'https://api-dashboard.search.brave.com/',
    'Brave Search API key'
  ),
  GITHUB,
  ...(Object.keys(CLOUD_PROVIDER_LABELS) as CloudProviderId[])
    .filter((id): id is KeyedProvider => id !== 'azure')
    .map(providerTarget)
]

export function findKeyTarget(id: string): KeyTarget | undefined {
  const wanted = id.trim().toLowerCase()
  return KEY_TARGETS.find((target) => target.id === wanted || target.name.toLowerCase() === wanted)
}

/** "tvly-…3f2a": enough to recognise a key, never enough to use it. */
export function maskKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length <= 8) return '••••'
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`
}
