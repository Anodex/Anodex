import type { ProviderSettings } from '@shared/settings.types'
import { llamaService } from '../llama/LlamaService'
import { settingsStore } from '../settings/SettingsStore'
import { anthropicProvider } from './AnthropicProvider'
import { openAiProvider } from './OpenAiProvider'
import { azureOpenAiProvider } from './AzureOpenAiProvider'
import { openAiCompatibleProviders } from './cloudProviderConfigs'
import type { LlmProvider } from './LlmProvider'

const localProvider: LlmProvider = {
  id: 'local',
  generate: (params) => llamaService.generate(params)
}

const providers: Record<ProviderSettings['active'], LlmProvider> = {
  local: localProvider,
  anthropic: anthropicProvider,
  openai: openAiProvider,
  azure: azureOpenAiProvider,
  ...openAiCompatibleProviders
}

/**
 * Returns the provider that should handle the next generation. Defaults to the
 * user's global `provider.active` setting; `overrideId` lets a specific caller
 * (an agent run picking its own provider — see `RunGenerationIo.providerOverride`)
 * use a different one without touching that global setting. Falls back to
 * `local` for an unknown or unset value either way, so a corrupt/older
 * settings file (or a bad override) can't leave generation unusable.
 */
export function getActiveProvider(overrideId?: ProviderSettings['active']): LlmProvider {
  const active = overrideId ?? settingsStore.get().provider.active
  return providers[active] ?? localProvider
}
