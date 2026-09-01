/**
 * Which providers an agent run may use, and how to seed one.
 *
 * Agent runs long accepted only `local | anthropic | openai` while chat
 * accepted twelve. That was a deliberate deferral rather than an oversight —
 * `AgentRunEditor.tsx` said so in a comment — but it had a cost that was not
 * written down: a user could configure DeepSeek, see it connected in Settings,
 * start a Workspace run, and get a *local* run instead, because the editor
 * resolved any unsupported provider to `local` with nothing on screen saying
 * so. A run's provenance then recorded local, and the key appeared to do
 * nothing.
 *
 * The generation path never had this limit — `RunGenerationIo.providerOverride`
 * has always been typed as the full `ProviderSettings['active']` union — so
 * this is a registry over what already worked, not new provider plumbing.
 *
 * Adding a provider to chat now adds it to agent runs by adding one row here;
 * there is deliberately no per-provider branching anywhere else in the agent
 * layer, which is what let the two unions drift apart in the first place.
 */
import type { AppSettings, ProviderSettings } from './settings.types'
import { cloudContextWindowTokens } from './contextBudget'
import { resolveModelContextSize } from './modelContextSize'
import { ANTHROPIC_MODELS, DEFAULT_ANTHROPIC_MODEL } from './anthropicModels'
import { OPENAI_MODELS, DEFAULT_OPENAI_MODEL } from './openaiModels'
import { GOOGLE_MODELS, DEFAULT_GOOGLE_MODEL } from './googleModels'
import { XAI_MODELS, DEFAULT_XAI_MODEL } from './xaiModels'
import { DEEPSEEK_MODELS, DEFAULT_DEEPSEEK_MODEL } from './deepseekModels'
import { MISTRAL_MODELS, DEFAULT_MISTRAL_MODEL } from './mistralModels'
import { GROQ_MODELS, DEFAULT_GROQ_MODEL } from './groqModels'
import { OPENROUTER_MODELS, DEFAULT_OPENROUTER_MODEL } from './openrouterModels'
import { KIMI_MODELS, DEFAULT_KIMI_MODEL } from './kimiModels'
import { QWEN_MODELS, DEFAULT_QWEN_MODEL } from './qwenModels'

/** Every backend an agent run may use — the same union chat accepts. */
export type AgentRunProviderId = ProviderSettings['active']

/** The shape this module needs from a model catalog; catalogs carry more. */
interface ModelChoice {
  id: string
  label: string
}

interface AgentRunProvider {
  /** Human label for the run editor's provider select. */
  label: string
  /**
   * Short vendor name for a run badge, e.g. "Claude" where `label` says
   * "Claude (Anthropic)". The select can afford the longer form; a row in the
   * run list cannot.
   */
  vendor: string
  /**
   * Whether this install could actually authenticate as this provider right
   * now. A provider that cannot is never offered, because a run created
   * against it fails on its first turn — which reads to the user as Anodex
   * being broken rather than as a missing key.
   */
  isConfigured: (settings: ProviderSettings) => boolean
  /** Models offered for this provider, or null where the user names their own. */
  catalog: ModelChoice[] | null
  /**
   * The model id a new run should use: whatever the user chose in Settings,
   * else the catalog default. Empty string for `local`, which always uses the
   * loaded model and would be misrepresented by any id here.
   */
  resolveModel: (settings: ProviderSettings) => string
}

/** A cloud provider configured by an API key alone, which is most of them. */
function keyedProvider(
  label: string,
  vendor: string,
  key: Exclude<AgentRunProviderId, 'local' | 'azure'>,
  catalog: ModelChoice[],
  fallbackModel: string
): AgentRunProvider {
  return {
    label,
    vendor,
    isConfigured: (settings) => Boolean(settings[key].apiKey.trim()),
    catalog,
    resolveModel: (settings) => settings[key].model.trim() || fallbackModel
  }
}

const AGENT_RUN_PROVIDERS: Record<AgentRunProviderId, AgentRunProvider> = {
  local: {
    label: 'Local model',
    vendor: 'Local',
    // Always available: the local engine needs no credential. Whether a model
    // is *loaded* is a separate question the run editor already answers.
    isConfigured: () => true,
    catalog: null,
    resolveModel: () => ''
  },
  anthropic: keyedProvider(
    'Claude (Anthropic)',
    'Claude',
    'anthropic',
    ANTHROPIC_MODELS,
    DEFAULT_ANTHROPIC_MODEL
  ),
  openai: keyedProvider(
    'ChatGPT / Codex (OpenAI)',
    'OpenAI',
    'openai',
    OPENAI_MODELS,
    DEFAULT_OPENAI_MODEL
  ),
  google: keyedProvider('Google AI', 'Google AI', 'google', GOOGLE_MODELS, DEFAULT_GOOGLE_MODEL),
  xai: keyedProvider('xAI', 'xAI', 'xai', XAI_MODELS, DEFAULT_XAI_MODEL),
  deepseek: keyedProvider(
    'DeepSeek',
    'DeepSeek',
    'deepseek',
    DEEPSEEK_MODELS,
    DEFAULT_DEEPSEEK_MODEL
  ),
  mistral: keyedProvider(
    'Mistral AI',
    'Mistral AI',
    'mistral',
    MISTRAL_MODELS,
    DEFAULT_MISTRAL_MODEL
  ),
  groq: keyedProvider('Groq', 'Groq', 'groq', GROQ_MODELS, DEFAULT_GROQ_MODEL),
  openrouter: keyedProvider(
    'OpenRouter',
    'OpenRouter',
    'openrouter',
    OPENROUTER_MODELS,
    DEFAULT_OPENROUTER_MODEL
  ),
  azure: {
    label: 'Azure OpenAI',
    vendor: 'Azure OpenAI',
    // Azure needs a resource and a named deployment as well as a key — a key
    // alone locates nothing, so offering it would only produce a failed run.
    isConfigured: (settings) =>
      Boolean(
        settings.azure.apiKey.trim() &&
        settings.azure.resourceName.trim() &&
        settings.azure.deploymentName.trim()
      ),
    // The customer names their own deployments; there is no catalog to offer.
    catalog: null,
    resolveModel: (settings) => settings.azure.deploymentName.trim()
  },
  kimi: keyedProvider('Kimi', 'Kimi', 'kimi', KIMI_MODELS, DEFAULT_KIMI_MODEL),
  qwen: keyedProvider('Qwen', 'Qwen', 'qwen', QWEN_MODELS, DEFAULT_QWEN_MODEL)
}

/** Every agent-run provider id. Order is the run editor's display order. */
export const AGENT_RUN_PROVIDER_IDS = Object.keys(
  AGENT_RUN_PROVIDERS
) as readonly AgentRunProviderId[]

export interface AgentRunProviderOption {
  value: AgentRunProviderId
  label: string
}

/** The providers this install can actually authenticate as, in display order. */
export function agentRunProviderOptions(settings: ProviderSettings): AgentRunProviderOption[] {
  return AGENT_RUN_PROVIDER_IDS.filter((id) => AGENT_RUN_PROVIDERS[id].isConfigured(settings)).map(
    (id) => ({ value: id, label: AGENT_RUN_PROVIDERS[id].label })
  )
}

/** The model catalog for a provider's dropdown, or null where it names its own. */
export function agentRunModelCatalog(id: AgentRunProviderId): ModelChoice[] | null {
  return AGENT_RUN_PROVIDERS[id].catalog
}

/**
 * The model id configured for a provider: whatever the user chose in Settings,
 * else the catalog default; the deployment name for Azure, and empty for local,
 * which always uses the loaded model and would be misrepresented by any id.
 *
 * Used for a new run's model and by the chat context meter, which needs the
 * same answer to size the window it draws.
 */
export function configuredProviderModel(
  settings: ProviderSettings,
  id: AgentRunProviderId
): string {
  return AGENT_RUN_PROVIDERS[id].resolveModel(settings)
}

/**
 * Which provider a newly opened run editor should start on.
 *
 * A retry seed wins when its provider is still usable, then the globally active
 * provider, then local. Both candidates are checked against what this install
 * can authenticate as, because a key removed in Settings otherwise leaves the
 * select showing a value absent from its own options — and `Start run` then
 * creates a run that fails on its first turn.
 *
 * The fallback to `local` is the honest answer for a provider that cannot
 * authenticate. It is *not* a substitute for one that can: seeding a usable
 * DeepSeek install with `local` is the silent downgrade this replaced.
 */
export function seedAgentRunProvider(
  settings: ProviderSettings,
  seed: AgentRunProviderId | undefined
): AgentRunProviderId {
  const usable = (candidate: AgentRunProviderId | undefined): AgentRunProviderId | undefined =>
    candidate && AGENT_RUN_PROVIDERS[candidate]?.isConfigured(settings) ? candidate : undefined
  return usable(seed) ?? usable(settings.active) ?? 'local'
}

/** Short vendor name for a run badge, e.g. `Local`, `Claude`, `DeepSeek`. */
export function agentRunProviderVendor(id: AgentRunProviderId): string {
  return AGENT_RUN_PROVIDERS[id]?.vendor ?? id
}

/**
 * The friendly name for a model id, falling back to the id itself.
 *
 * A raw id is the right fallback rather than a blank: Azure deployments are
 * user-named and never in a catalog, and a live-fetched OpenAI id can be newer
 * than the bundled list.
 */
export function agentRunModelLabel(id: AgentRunProviderId, modelId: string | null): string {
  if (!modelId) return ''
  return AGENT_RUN_PROVIDERS[id]?.catalog?.find((m) => m.id === modelId)?.label ?? modelId
}

/** What `agentRunContextSize` needs to answer for a local run. */
type LocalWindowSettings = Pick<AppSettings, 'model' | 'modelContextSizes' | 'lastModelPath'>

/**
 * The context window a run will actually have, whichever provider it uses.
 *
 * The turn budget scales with this — a turn at 8,192 holds a fraction of what
 * one at 65,536 does, so a smaller window earns more turns to finish the same
 * work (see `maxTurnsCeilingFor`). Sizing that from the wrong window is
 * therefore not cosmetic: it decides how long a run is allowed to go on.
 *
 * Both callers used to read `settings.lastModelPath` regardless of provider, so
 * a cloud run inherited the turn budget of whatever `.gguf` happened to be
 * loaded last. With a small local model that meant a ceiling of 543 turns
 * handed to a cloud model with a million-token window — and every one of those
 * turns is billed.
 *
 * An unknown cloud model falls through to `DEFAULT_CLOUD_CONTEXT_WINDOW_TOKENS`
 * rather than to undefined, which keeps a live-fetched id newer than the
 * bundled catalog, and a user-named Azure deployment, bounded rather than
 * unbounded.
 */
export function agentRunContextSize(
  settings: LocalWindowSettings | null | undefined,
  provider: AgentRunProviderId,
  modelId: string | null | undefined
): number | undefined {
  if (provider === 'local') {
    return resolveModelContextSize(settings, settings?.lastModelPath ?? null)
  }
  return cloudContextWindowTokens(provider, modelId ?? '')
}
