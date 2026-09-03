import type { ProviderSettings } from './settings.types'
import type { CloudModelOption } from './cloudModelOption'
import { ANTHROPIC_MODELS } from './anthropicModels'
import { OPENAI_MODELS } from './openaiModels'
import { GOOGLE_MODELS } from './googleModels'
import { XAI_MODELS } from './xaiModels'
import { DEEPSEEK_MODELS } from './deepseekModels'
import { MISTRAL_MODELS } from './mistralModels'
import { GROQ_MODELS } from './groqModels'
import { OPENROUTER_MODELS } from './openrouterModels'
import { KIMI_MODELS } from './kimiModels'
import { QWEN_MODELS } from './qwenModels'

/**
 * One place that knows the cloud providers by name and by catalog.
 *
 * The same two facts — what a provider is called, and which models it offers —
 * were being restated per feature, and every restatement was a chance to list
 * fewer providers than exist. The sidebar model menu listed two of eleven for
 * exactly that reason, and the system prompt hardcoded "running locally"
 * because nothing there could name the provider actually answering.
 *
 * Adding a provider means adding it here and to `ProviderSettings`; features
 * that iterate this record pick it up without being edited.
 */

/** Every provider that is not the built-in local engine. */
export type CloudProviderId = Exclude<ProviderSettings['active'], 'local'>

export const CLOUD_PROVIDER_LABELS: Record<CloudProviderId, string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
  google: 'Google AI',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  mistral: 'Mistral AI',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  azure: 'Azure OpenAI',
  kimi: 'Kimi',
  qwen: 'Qwen'
}

/**
 * The curated model catalog per provider.
 *
 * Azure is deliberately absent rather than empty: its "model" *is* the
 * deployment name the user typed, so there is no list to choose from. Callers
 * must handle that as its own case — see `cloudProviderModels`.
 */
export const CLOUD_PROVIDER_MODELS: Record<
  Exclude<CloudProviderId, 'azure'>,
  readonly CloudModelOption[]
> = {
  // `AnthropicModelOption` and `OpenAiModelOption` predate `CloudModelOption`
  // and are structurally identical to it, so they slot in without a mapping.
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  google: GOOGLE_MODELS,
  xai: XAI_MODELS,
  deepseek: DEEPSEEK_MODELS,
  mistral: MISTRAL_MODELS,
  groq: GROQ_MODELS,
  openrouter: OPENROUTER_MODELS,
  kimi: KIMI_MODELS,
  qwen: QWEN_MODELS
}

export const CLOUD_PROVIDER_IDS = Object.keys(CLOUD_PROVIDER_LABELS) as CloudProviderId[]

export function isCloudProviderId(id: string): id is CloudProviderId {
  return id in CLOUD_PROVIDER_LABELS
}

/** A provider's selectable models, or `null` for Azure, which has no list. */
export function cloudProviderModels(id: CloudProviderId): readonly CloudModelOption[] | null {
  return id === 'azure' ? null : CLOUD_PROVIDER_MODELS[id]
}

/**
 * A provider's configured model and whether its credentials are complete,
 * across both shapes: the plain `{apiKey, model}` most providers use, and
 * Azure's `{apiKey, resourceName, deploymentName}`.
 */
export function cloudProviderState(
  provider: ProviderSettings | undefined,
  id: CloudProviderId
): { model: string; apiKeySet: boolean } | null {
  if (!provider) return null
  if (id === 'azure') {
    const azure = provider.azure
    return {
      model: azure.deploymentName.trim(),
      apiKeySet: Boolean(
        azure.apiKey.trim() && azure.resourceName.trim() && azure.deploymentName.trim()
      )
    }
  }
  const settings = provider[id]
  return { model: settings.model, apiKeySet: Boolean(settings.apiKey.trim()) }
}

/** How to name the engine answering a turn, for the system prompt and the UI. */
export function providerDisplayLabel(id: ProviderSettings['active']): string {
  return id === 'local' ? 'the built-in local engine' : CLOUD_PROVIDER_LABELS[id]
}
