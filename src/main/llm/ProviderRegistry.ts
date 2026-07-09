import { llamaService } from '../llama/LlamaService'
import { settingsStore } from '../settings/SettingsStore'
import { anthropicProvider } from './AnthropicProvider'
import { openAiProvider } from './OpenAiProvider'
import type { LlmProvider } from './LlmProvider'

const localProvider: LlmProvider = {
  id: 'local',
  generate: (params) => llamaService.generate(params)
}

const providers: Record<string, LlmProvider> = {
  local: localProvider,
  anthropic: anthropicProvider,
  openai: openAiProvider
}

/**
 * Returns the provider that should handle the next generation, based on the
 * user's `provider.active` setting. Falls back to `local` for an unknown or
 * unset value so a corrupt/older settings file can't leave chat unusable.
 */
export function getActiveProvider(): LlmProvider {
  const active = settingsStore.get().provider.active
  return providers[active] ?? localProvider
}
