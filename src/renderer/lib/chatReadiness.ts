import type { AppSettings } from '@shared/settings.types'
import type { EngineState } from '@shared/model.types'
import { isProviderConfigured } from '@shared/agentRunProviders'

/**
 * Whether the active provider can generate a reply right now.
 *
 * The local engine's readiness comes from `EngineState.status`; the cloud
 * providers need no loaded model, only a configured API key. Chat send
 * gating (`ChatComposer`, `chatStore.sendMessage`) should use this instead of
 * reading `engine.status` directly, so switching providers doesn't leave the
 * composer stuck showing "load a model" when a cloud provider is active, or
 * vice versa.
 */
export function isChatReady(
  settings: AppSettings | null,
  engineStatus: EngineState['status']
): boolean {
  if (!settings) return false
  // Only the local engine needs a loaded model. Every cloud provider needs a
  // usable credential and nothing else - this named two of them and sent the
  // other nine down the local path, blocking the composer on a model they do
  // not use.
  if (settings.provider.active === 'local') return engineStatus === 'ready'
  return isProviderConfigured(settings.provider, settings.provider.active)
}
