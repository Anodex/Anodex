import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, SettingsPatch } from '@shared/settings.types'
import { ANTHROPIC_MODELS } from '@shared/anthropicModels'
import { OPENAI_MODELS } from '@shared/openaiModels'
import { GOOGLE_MODELS } from '@shared/googleModels'
import { XAI_MODELS } from '@shared/xaiModels'
import { DEEPSEEK_MODELS } from '@shared/deepseekModels'
import { MISTRAL_MODELS } from '@shared/mistralModels'
import { GROQ_MODELS } from '@shared/groqModels'
import { OPENROUTER_MODELS } from '@shared/openrouterModels'
import { KIMI_MODELS } from '@shared/kimiModels'
import { QWEN_MODELS } from '@shared/qwenModels'
import type { CloudModelOption } from '@shared/cloudModelOption'
import anodexIcon from '../../../../assets/app-icon.png'
import anthropicLogo from '../../../../assets/providers/anthropic.svg'
import azureOpenAiLogo from '../../../../assets/providers/azure-openai.svg'
import deepSeekLogo from '../../../../assets/providers/deepseek.svg'
import googleLogo from '../../../../assets/providers/google.svg'
import groqLogo from '../../../../assets/providers/groq.svg'
import kimiLogo from '../../../../assets/providers/kimi.svg'
import mistralLogo from '../../../../assets/providers/mistral.svg'
import openAiLogo from '../../../../assets/providers/openai.svg'
import openRouterLogo from '../../../../assets/providers/openrouter.svg'
import qwenLogo from '../../../../assets/providers/qwen.svg'
import xAiLogo from '../../../../assets/providers/xai.svg'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import { SettingRow } from '../../SettingRow'
import { SelectControl, TextControl, ToggleControl } from '../../controls'
import { ApiKeyField } from './ApiKeyField'
import styles from './AiModelsSettings.module.css'

type ProviderId =
  | 'local'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'deepseek'
  | 'mistral'
  | 'groq'
  | 'openrouter'
  | 'azure'
  | 'kimi'
  | 'qwen'

/**
 * Every provider whose settings are the plain `{apiKey, model, dailyTokenCap}`
 * shape and whose fields this panel renders through one shared block (see
 * `SIMPLE_PROVIDER_MODELS` below) rather than a bespoke one — mirrors
 * `OpenAiCompatibleProviderId` on the main-process side, but this is its own
 * renderer-side type since the two sides can't share a module.
 */
type SimpleCloudProviderId =
  'google' | 'xai' | 'deepseek' | 'mistral' | 'groq' | 'openrouter' | 'kimi' | 'qwen'

/** Each simple cloud provider's curated model catalog, for its dropdown. */
const SIMPLE_PROVIDER_MODELS: Record<SimpleCloudProviderId, CloudModelOption[]> = {
  google: GOOGLE_MODELS,
  xai: XAI_MODELS,
  deepseek: DEEPSEEK_MODELS,
  mistral: MISTRAL_MODELS,
  groq: GROQ_MODELS,
  openrouter: OPENROUTER_MODELS,
  kimi: KIMI_MODELS,
  qwen: QWEN_MODELS
}

function isSimpleCloudProvider(id: ProviderId): id is SimpleCloudProviderId {
  return id in SIMPLE_PROVIDER_MODELS
}

const API_KEY_PLACEHOLDERS: Partial<Record<SimpleCloudProviderId, string>> = {
  xai: 'xai-...',
  deepseek: 'sk-...',
  mistral: '...',
  groq: 'gsk_...',
  openrouter: 'sk-or-...'
}

type ProviderFilter = 'all' | 'direct' | 'cloud'

interface ProviderDefinition {
  id: ProviderId
  name: string
  shortName: string
  logoSrc?: string
  category: 'local' | 'direct' | 'cloud'
  meta: string
  description: string
  capabilities: string[]
  available: boolean
}

const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'local',
    name: 'Local model',
    shortName: 'A',
    // Anodex's own app icon, not a model-vendor mark: this entry is the
    // built-in engine, not a connection to someone else's API. Deliberately
    // not a Llama logo — `node-llama-cpp` is only the runtime here, and the
    // GGUFs users actually load through it span every model family.
    logoSrc: anodexIcon,
    category: 'local',
    meta: 'Built in',
    description: 'Run private GGUF models directly on this computer.',
    capabilities: ['Private', 'Offline', 'Tools'],
    available: true
  },
  {
    id: 'openai',
    name: 'OpenAI',
    shortName: 'O',
    logoSrc: openAiLogo,
    category: 'direct',
    meta: 'Direct API',
    description: 'Connect directly to OpenAI for GPT and Codex models.',
    capabilities: ['Chat', 'Vision', 'Tools', 'Streaming'],
    available: true
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    shortName: 'A',
    logoSrc: anthropicLogo,
    category: 'direct',
    meta: 'Claude models',
    description: 'Connect directly to Anthropic for Claude models.',
    capabilities: ['Chat', 'Vision', 'Tools', 'Long context'],
    available: true
  },
  {
    id: 'google',
    name: 'Google AI',
    shortName: 'G',
    logoSrc: googleLogo,
    category: 'direct',
    meta: 'Gemini models',
    description: 'Direct access to Google Gemini models.',
    capabilities: ['Chat', 'Vision', 'Tools', 'Long context'],
    available: true
  },
  {
    id: 'xai',
    name: 'xAI',
    shortName: 'x',
    logoSrc: xAiLogo,
    category: 'direct',
    meta: 'Grok models',
    description: 'Direct access to xAI Grok models.',
    capabilities: ['Chat', 'Vision', 'Tools'],
    available: true
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    shortName: 'D',
    logoSrc: deepSeekLogo,
    category: 'direct',
    meta: 'Direct API',
    description: 'Direct access to DeepSeek reasoning and coding models.',
    capabilities: ['Chat', 'Reasoning', 'Tools'],
    available: true
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    shortName: 'M',
    logoSrc: mistralLogo,
    category: 'direct',
    meta: 'Direct API',
    description: 'Direct access to Mistral and Codestral models.',
    capabilities: ['Chat', 'Coding', 'Tools'],
    available: true
  },
  {
    id: 'groq',
    name: 'Groq',
    shortName: 'G',
    logoSrc: groqLogo,
    category: 'cloud',
    meta: 'Fast inference',
    description: 'Hosted high-speed inference for supported open models.',
    capabilities: ['Chat', 'Tools', 'Fast inference'],
    available: true
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    shortName: 'OR',
    logoSrc: openRouterLogo,
    category: 'cloud',
    meta: 'Model gateway',
    description: 'Use one connection to access models from many providers.',
    capabilities: ['Chat', 'Model routing', 'Tools'],
    available: true
  },
  {
    id: 'kimi',
    name: 'Kimi',
    shortName: 'K',
    logoSrc: kimiLogo,
    category: 'direct',
    meta: 'Moonshot AI',
    description: 'Direct access to Moonshot AI Kimi models.',
    capabilities: ['Chat', 'Long context', 'Tools'],
    available: true
  },
  {
    id: 'qwen',
    name: 'Qwen',
    shortName: 'Q',
    logoSrc: qwenLogo,
    category: 'direct',
    meta: 'Alibaba Cloud',
    description: 'Direct access to hosted Alibaba Cloud Qwen models.',
    capabilities: ['Chat', 'Coding', 'Tools'],
    available: true
  },
  {
    id: 'azure',
    name: 'Azure OpenAI',
    shortName: 'Az',
    logoSrc: azureOpenAiLogo,
    category: 'cloud',
    meta: 'Enterprise cloud',
    description: 'Connect an Azure OpenAI resource and deployment.',
    capabilities: ['Chat', 'Vision', 'Tools', 'Enterprise'],
    available: true
  }
]

const ANTHROPIC_MODEL_OPTIONS = ANTHROPIC_MODELS.map((model) => ({
  label: model.label,
  value: model.id
}))

const OPENAI_MODEL_OPTIONS = OPENAI_MODELS.map((model) => ({
  label: model.label,
  value: model.id
}))

function parseDailyCapInput(value: string): number | null | undefined {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined
}

function DailyCapInput({
  value,
  onCommit
}: {
  value: number | null
  onCommit: (cap: number | null) => void
}): JSX.Element {
  const [text, setText] = useState(value?.toString() ?? '')
  return (
    <TextControl
      value={text}
      placeholder="No cap"
      onChange={(next) => {
        setText(next)
        const cap = parseDailyCapInput(next)
        if (cap !== undefined) onCommit(cap)
      }}
    />
  )
}

/**
 * Value restored when the reply ceiling is switched back on, if the provider
 * has never had one. Low enough to be an obviously deliberate cap rather than
 * a number that quietly truncates long replies.
 */
const DEFAULT_MAX_RESPONSE_TOKENS = 4096

/**
 * Per-provider reply ceiling, shown beside that provider's daily token cap.
 *
 * Off by default for the local engine, where the value can only lower a limit
 * the engine already measures per turn and a too-low setting loses whole turns
 * to tool calls cut off mid-arguments. Cloud providers fall back to their own
 * API default when it is off, since those APIs require a ceiling per request.
 */
function MaxResponseTokensRow({
  value,
  isLocal,
  onCommit
}: {
  value: number | null
  isLocal: boolean
  onCommit: (tokens: number | null) => void
}): JSX.Element {
  const [text, setText] = useState(value?.toString() ?? '')
  useEffect(() => {
    setText(value?.toString() ?? '')
  }, [value])

  return (
    <SettingRow
      label="Max response tokens"
      description={
        isLocal
          ? 'Off by default. Each reply already gets whatever room the context has left, so a manual cap can only shorten it — and one set too low can cut a tool call short and lose the turn.'
          : "Upper bound on tokens generated per reply, and so on what one reply can cost. Off uses this provider's own default."
      }
      control={
        <div className={styles.maxResponseTokensControl}>
          <ToggleControl
            checked={value !== null}
            ariaLabel="Limit response tokens"
            onChange={(checked) =>
              onCommit(checked ? (value ?? DEFAULT_MAX_RESPONSE_TOKENS) : null)
            }
          />
          {value !== null && (
            <TextControl
              value={text}
              placeholder={String(DEFAULT_MAX_RESPONSE_TOKENS)}
              onChange={(next) => {
                setText(next)
                const parsed = Number(next.trim())
                if (Number.isFinite(parsed) && parsed > 0) onCommit(Math.round(parsed))
              }}
            />
          )}
        </div>
      }
    />
  )
}

function providerConnected(id: ProviderId, settings: AppSettings): boolean {
  if (id === 'local') return true
  if (id === 'openai') return Boolean(settings.provider.openai.apiKey.trim())
  if (id === 'anthropic') return Boolean(settings.provider.anthropic.apiKey.trim())
  if (id === 'azure') {
    const azure = settings.provider.azure
    return Boolean(azure.apiKey.trim() && azure.resourceName.trim() && azure.deploymentName.trim())
  }
  if (isSimpleCloudProvider(id)) return Boolean(settings.provider[id].apiKey.trim())
  return false
}

function activeProviderDefinition(settings: AppSettings): ProviderDefinition {
  return PROVIDERS.find((provider) => provider.id === settings.provider.active) ?? PROVIDERS[0]
}

/** The active provider's model/detail line shown on the "Active provider" card. */
function activeProviderDetail(settings: AppSettings, activeModelName: string | null): string {
  const active = settings.provider.active
  if (active === 'local') return `${activeModelName ?? 'No model loaded'} · Private and offline`
  if (active === 'openai') return settings.provider.openai.model
  if (active === 'anthropic') return settings.provider.anthropic.model
  if (active === 'azure') return settings.provider.azure.deploymentName || 'No deployment set'
  if (isSimpleCloudProvider(active)) return settings.provider[active].model
  return ''
}

function ProviderLogo({ provider }: { provider: ProviderDefinition }): JSX.Element {
  return (
    <span
      className={`${styles.providerLogo} ${styles[`providerLogo${provider.id}`]} ${
        provider.logoSrc ? styles.providerLogoOfficial : ''
      }`}
      aria-hidden="true"
    >
      {provider.logoSrc ? (
        <img src={provider.logoSrc} alt="" draggable={false} />
      ) : (
        provider.shortName
      )}
    </span>
  )
}

export function ProviderConnectionsPanel({
  settings,
  activeModelName,
  onUpdate,
  onOpenModels
}: {
  settings: AppSettings
  activeModelName: string | null
  onUpdate: (patch: SettingsPatch) => Promise<void>
  onOpenModels: () => void
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<ProviderId>(settings.provider.active)
  const [filter, setFilter] = useState<ProviderFilter>('all')
  const [search, setSearch] = useState('')

  const selected = PROVIDERS.find((provider) => provider.id === selectedId) ?? PROVIDERS[0]
  const active = activeProviderDefinition(settings)
  const activeConnected = providerConnected(active.id, settings)
  const connectedCount = PROVIDERS.filter((provider) =>
    providerConnected(provider.id, settings)
  ).length
  const filteredProviders = useMemo(() => {
    const query = search.trim().toLowerCase()
    return PROVIDERS.filter((provider) => {
      const matchesFilter =
        filter === 'all' || provider.category === filter || provider.category === 'local'
      const matchesSearch = `${provider.name} ${provider.meta} ${provider.description}`
        .toLowerCase()
        .includes(query)
      return matchesFilter && matchesSearch
    })
  }, [filter, search])

  const activeDetail = activeProviderDetail(settings, activeModelName)

  return (
    <div className={styles.providerTabContent}>
      <section className={styles.sectionFlush}>
        <div className={styles.sectionTitleRow}>
          <div>
            <h2 className={styles.sectionTitle}>Chat routing</h2>
            <p className={styles.sectionDesc}>Choose which connected provider generates replies.</p>
          </div>
          <span className={styles.localFirstBadge}>
            <Icon name="shield-check" size={13} />
            {settings.provider.active === 'local' ? 'Local-first default' : 'Cloud provider active'}
          </span>
        </div>

        <div className={styles.activeProviderCard}>
          <ProviderLogo provider={active} />
          <div className={styles.activeProviderIdentity}>
            <span>Active provider</span>
            <strong>{active.name}</strong>
            <small>{activeDetail}</small>
          </div>
          {/* Reads the same `providerConnected` the catalog and detail pane
              use. This badge used to be the literal word "Ready", which was a
              claim it never checked: clearing the API key of the provider that
              is currently active — doable a few rows below, without changing
              which provider is active — left this card saying Ready while the
              composer was disabled and telling the user to add a key. */}
          <span
            className={`${styles.providerReady} ${activeConnected ? '' : styles.providerNotReady}`}
          >
            <span /> {activeConnected ? 'Ready' : 'Not connected'}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (settings.provider.active === 'local') onOpenModels()
              else setSelectedId(settings.provider.active)
            }}
          >
            Manage
          </Button>
        </div>

        <div className={styles.providerPrivacyNote}>
          <Icon name="shield-check" size={14} />
          Connecting a cloud provider does not activate it. Anodex stays local until you choose a
          connected provider for chat.
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitleRow}>
          <div>
            <h2 className={styles.sectionTitle}>Provider connections</h2>
            <p className={styles.sectionDesc}>
              Add direct APIs, model gateways, and enterprise cloud services.
            </p>
          </div>
          <span className={styles.providerCount}>
            {connectedCount} connected · {PROVIDERS.length} providers
          </span>
        </div>

        <div className={styles.providerWorkspace}>
          <aside className={styles.providerCatalog} aria-label="Provider catalog">
            <label className={styles.providerSearch}>
              <Icon name="search" size={14} />
              <input
                value={search}
                aria-label="Search providers"
                placeholder="Search providers"
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className={styles.providerFilters} aria-label="Provider filters">
              {(['all', 'direct', 'cloud'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={filter === value ? styles.providerFilterActive : undefined}
                  onClick={() => setFilter(value)}
                >
                  {value[0].toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
            <div className={styles.providerList}>
              {filteredProviders.map((provider) => {
                const connected = providerConnected(provider.id, settings)
                const isActive = settings.provider.active === provider.id
                return (
                  <button
                    key={provider.id}
                    type="button"
                    className={`${styles.providerListItem} ${
                      selected.id === provider.id ? styles.providerListItemSelected : ''
                    }`}
                    onClick={() => setSelectedId(provider.id)}
                  >
                    <ProviderLogo provider={provider} />
                    <span className={styles.providerListIdentity}>
                      <strong>{provider.name}</strong>
                      <small>{provider.meta}</small>
                    </span>
                    <span
                      className={`${styles.providerListState} ${
                        connected ? styles.providerListStateReady : ''
                      }`}
                    >
                      {isActive
                        ? 'Active'
                        : connected
                          ? 'Ready'
                          : provider.available
                            ? 'Add'
                            : 'Soon'}
                    </span>
                  </button>
                )
              })}
              {filteredProviders.length === 0 && (
                <p className={styles.providerEmpty}>No providers match this search.</p>
              )}
            </div>
          </aside>

          <div className={styles.providerDetail}>
            <div className={styles.providerDetailHead}>
              <ProviderLogo provider={selected} />
              <div>
                <h3>{selected.name}</h3>
                <p>
                  {selected.meta} ·{' '}
                  {providerConnected(selected.id, settings)
                    ? settings.provider.active === selected.id
                      ? 'Active'
                      : 'Connected'
                    : selected.available
                      ? 'Not connected'
                      : 'Coming soon'}
                </p>
              </div>
              {selected.available && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={
                    settings.provider.active === selected.id ||
                    !providerConnected(selected.id, settings)
                  }
                  onClick={() => void onUpdate({ provider: { active: selected.id } })}
                >
                  {settings.provider.active === selected.id ? 'Active provider' : 'Use for chat'}
                </Button>
              )}
            </div>

            <p className={styles.providerDescription}>{selected.description}</p>
            <div className={styles.providerCapabilities}>
              {selected.capabilities.map((capability) => (
                <span key={capability}>{capability}</span>
              ))}
            </div>

            {selected.id === 'local' && (
              <>
                <div className={styles.providerLocalPanel}>
                  <span>Current local model</span>
                  <strong>{activeModelName ?? 'No model loaded'}</strong>
                  <p>Local models keep prompts, project context, and replies on this computer.</p>
                  <Button variant="secondary" size="sm" onClick={onOpenModels}>
                    Manage local models
                  </Button>
                </div>
                <div className={styles.providerFields}>
                  {/* No API key, model id, or daily cap here — nothing local is
                      billed, so the reply ceiling and the context replay mode
                      are the only settings. */}
                  <MaxResponseTokensRow
                    isLocal
                    value={settings.provider.local.maxResponseTokens}
                    onCommit={(tokens) =>
                      void onUpdate({ provider: { local: { maxResponseTokens: tokens } } })
                    }
                  />
                  <p className={styles.providerLocalDescription}>
                    Context Ledger: Anodex keeps the active interaction together, summarizes older
                    work when needed, and preserves room for the next turn.
                  </p>
                </div>
              </>
            )}

            {selected.id === 'openai' && (
              <div className={styles.providerFields}>
                <SettingRow
                  label="API key"
                  description="Stored securely on this computer. Use Test connection to verify it."
                  control={
                    <ApiKeyField
                      provider="openai"
                      value={settings.provider.openai.apiKey}
                      model={settings.provider.openai.model}
                      placeholder="sk-..."
                      onChange={(value) =>
                        void onUpdate({ provider: { openai: { apiKey: value } } })
                      }
                    />
                  }
                />
                <SettingRow
                  label="Model"
                  description="OpenAI model used for chat generations."
                  control={
                    <SelectControl
                      value={settings.provider.openai.model}
                      options={OPENAI_MODEL_OPTIONS}
                      onChange={(value) =>
                        void onUpdate({ provider: { openai: { model: value } } })
                      }
                    />
                  }
                />
                <SettingRow
                  label="Daily token cap"
                  description="Optional warning threshold. It never blocks a message."
                  control={
                    <DailyCapInput
                      value={settings.provider.openai.dailyTokenCap}
                      onCommit={(cap) =>
                        void onUpdate({ provider: { openai: { dailyTokenCap: cap } } })
                      }
                    />
                  }
                />
                <MaxResponseTokensRow
                  isLocal={false}
                  value={settings.provider.openai.maxResponseTokens}
                  onCommit={(tokens) =>
                    void onUpdate({ provider: { openai: { maxResponseTokens: tokens } } })
                  }
                />
                <div className={styles.providerDataNote}>
                  <Icon name="info" size={14} />
                  Messages and selected context are sent to OpenAI only while it is active.
                </div>
              </div>
            )}

            {selected.id === 'anthropic' && (
              <div className={styles.providerFields}>
                <SettingRow
                  label="API key"
                  description="Stored securely on this computer. Use Test connection to verify it."
                  control={
                    <ApiKeyField
                      provider="anthropic"
                      value={settings.provider.anthropic.apiKey}
                      model={settings.provider.anthropic.model}
                      placeholder="sk-ant-..."
                      onChange={(value) =>
                        void onUpdate({ provider: { anthropic: { apiKey: value } } })
                      }
                    />
                  }
                />
                <SettingRow
                  label="Model"
                  description="Claude model used for chat generations."
                  control={
                    <SelectControl
                      value={settings.provider.anthropic.model}
                      options={ANTHROPIC_MODEL_OPTIONS}
                      onChange={(value) =>
                        void onUpdate({ provider: { anthropic: { model: value } } })
                      }
                    />
                  }
                />
                <SettingRow
                  label="Daily token cap"
                  description="Optional warning threshold. It never blocks a message."
                  control={
                    <DailyCapInput
                      value={settings.provider.anthropic.dailyTokenCap}
                      onCommit={(cap) =>
                        void onUpdate({ provider: { anthropic: { dailyTokenCap: cap } } })
                      }
                    />
                  }
                />
                <MaxResponseTokensRow
                  isLocal={false}
                  value={settings.provider.anthropic.maxResponseTokens}
                  onCommit={(tokens) =>
                    void onUpdate({ provider: { anthropic: { maxResponseTokens: tokens } } })
                  }
                />
                <div className={styles.providerDataNote}>
                  <Icon name="info" size={14} />
                  Messages and selected context are sent to Anthropic only while it is active.
                </div>
              </div>
            )}

            {isSimpleCloudProvider(selected.id) && (
              // Keyed by provider. The other four providers each have their own
              // conditional slot, so switching between them unmounts one and
              // mounts another; these eight share this one, and without a key
              // React sees the same `div` in the same position and keeps the
              // subtree — and its state — alive across the switch. That handed
              // one provider's local state to the next: `DailyCapInput` seeds
              // its text once at mount, so a cap set on Google was still
              // displayed under xAI while xAI's real cap was something else
              // entirely, and `ApiKeyField` kept its per-mount auto-verify from
              // firing (a saved, valid key read as "Unverified") along with any
              // in-flight check, so the new provider's dot could show
              // "Checking…" for the previous provider's request.
              <div className={styles.providerFields} key={selected.id}>
                <SettingRow
                  label="API key"
                  description="Stored securely on this computer. Use Test connection to verify it."
                  control={
                    <ApiKeyField
                      provider={selected.id}
                      value={settings.provider[selected.id].apiKey}
                      model={settings.provider[selected.id].model}
                      placeholder={API_KEY_PLACEHOLDERS[selected.id] ?? 'API key'}
                      onChange={(value) =>
                        void onUpdate({ provider: { [selected.id]: { apiKey: value } } })
                      }
                    />
                  }
                />
                <SettingRow
                  label="Model"
                  description={`${selected.name} model used for chat generations.`}
                  control={
                    <SelectControl
                      value={settings.provider[selected.id].model}
                      options={SIMPLE_PROVIDER_MODELS[selected.id].map((model) => ({
                        label: model.label,
                        value: model.id
                      }))}
                      onChange={(value) =>
                        void onUpdate({ provider: { [selected.id]: { model: value } } })
                      }
                    />
                  }
                />
                <SettingRow
                  label="Daily token cap"
                  description="Optional warning threshold. It never blocks a message."
                  control={
                    <DailyCapInput
                      value={settings.provider[selected.id].dailyTokenCap}
                      onCommit={(cap) =>
                        void onUpdate({ provider: { [selected.id]: { dailyTokenCap: cap } } })
                      }
                    />
                  }
                />
                <MaxResponseTokensRow
                  isLocal={false}
                  value={settings.provider[selected.id].maxResponseTokens}
                  onCommit={(tokens) =>
                    void onUpdate({ provider: { [selected.id]: { maxResponseTokens: tokens } } })
                  }
                />
                <div className={styles.providerDataNote}>
                  <Icon name="info" size={14} />
                  Messages and selected context are sent to {selected.name} only while it is active.
                </div>
              </div>
            )}

            {selected.id === 'azure' && (
              <div className={styles.providerFields}>
                <SettingRow
                  label="Resource name"
                  description="The Azure resource name, e.g. `my-resource` for my-resource.openai.azure.com."
                  control={
                    <TextControl
                      value={settings.provider.azure.resourceName}
                      placeholder="my-resource"
                      onChange={(value) =>
                        void onUpdate({ provider: { azure: { resourceName: value } } })
                      }
                    />
                  }
                />
                <SettingRow
                  label="Deployment name"
                  description="The deployment name you created in Azure AI Studio for your chosen model."
                  control={
                    <TextControl
                      value={settings.provider.azure.deploymentName}
                      placeholder="my-deployment"
                      onChange={(value) =>
                        void onUpdate({ provider: { azure: { deploymentName: value } } })
                      }
                    />
                  }
                />
                <SettingRow
                  label="API version"
                  description="Azure OpenAI REST API version."
                  control={
                    <TextControl
                      value={settings.provider.azure.apiVersion}
                      placeholder="2024-10-21"
                      onChange={(value) =>
                        void onUpdate({ provider: { azure: { apiVersion: value } } })
                      }
                    />
                  }
                />
                <SettingRow
                  label="API key"
                  description="Stored securely on this computer. Use Test connection to verify it."
                  control={
                    <ApiKeyField
                      provider="azure"
                      value={settings.provider.azure.apiKey}
                      model={settings.provider.azure.deploymentName}
                      resourceName={settings.provider.azure.resourceName}
                      apiVersion={settings.provider.azure.apiVersion}
                      placeholder="Azure API key"
                      onChange={(value) =>
                        void onUpdate({ provider: { azure: { apiKey: value } } })
                      }
                    />
                  }
                />
                <SettingRow
                  label="Daily token cap"
                  description="Optional warning threshold. It never blocks a message."
                  control={
                    <DailyCapInput
                      value={settings.provider.azure.dailyTokenCap}
                      onCommit={(cap) =>
                        void onUpdate({ provider: { azure: { dailyTokenCap: cap } } })
                      }
                    />
                  }
                />
                <MaxResponseTokensRow
                  isLocal={false}
                  value={settings.provider.azure.maxResponseTokens}
                  onCommit={(tokens) =>
                    void onUpdate({ provider: { azure: { maxResponseTokens: tokens } } })
                  }
                />
                <div className={styles.providerDataNote}>
                  <Icon name="info" size={14} />
                  Messages and selected context are sent to your Azure OpenAI resource only while it
                  is active.
                </div>
              </div>
            )}

            {!selected.available && (
              <div className={styles.providerComingSoon}>
                <Icon name="sparkle" size={18} />
                <div>
                  <strong>Provider adapter planned</strong>
                  <p>
                    This entry is already part of the scalable provider library. Connection fields
                    will appear here when its runtime adapter ships.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
