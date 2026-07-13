import type { AppSettings } from '@shared/settings.types'
import type { EngineState } from '@shared/model.types'

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
  if (settings?.provider.active === 'anthropic') {
    return Boolean(settings.provider.anthropic.apiKey.trim())
  }
  if (settings?.provider.active === 'openai') {
    return Boolean(settings.provider.openai.apiKey.trim())
  }
  return engineStatus === 'ready'
}
