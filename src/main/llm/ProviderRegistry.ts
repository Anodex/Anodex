import { llamaService } from '../llama/LlamaService'
import type { LlmProvider } from './LlmProvider'

const localProvider: LlmProvider = {
  id: 'local',
  generate: (params) => llamaService.generate(params)
}

const providers: Record<string, LlmProvider> = {
  local: localProvider
}

/**
 * Returns the provider that should handle the next generation.
 *
 * Local is the only registered provider today, so this always returns it.
 * When a cloud provider is added, this is the one place that needs to change
 * (e.g. reading a `settings.provider` choice) — the rest of the chat pipeline
 * already talks to providers through {@link LlmProvider}, not `LlamaService` directly.
 */
export function getActiveProvider(): LlmProvider {
  return providers.local
}
