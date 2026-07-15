import { useMemo, useState } from 'react'
import type { AppSettings, DeepPartial } from '@shared/settings.types'
import { ANTHROPIC_MODELS } from '@shared/anthropicModels'
import { OPENAI_MODELS } from '@shared/openaiModels'
import amazonBedrockLogo from '../../../../assets/providers/amazon-bedrock.svg'
import anthropicLogo from '../../../../assets/providers/anthropic.svg'
import azureOpenAiLogo from '../../../../assets/providers/azure-openai.svg'
import deepSeekLogo from '../../../../assets/providers/deepseek.svg'
import googleLogo from '../../../../assets/providers/google.svg'
import groqLogo from '../../../../assets/providers/groq.svg'
import mistralLogo from '../../../../assets/providers/mistral.svg'
import openAiLogo from '../../../../assets/providers/openai.svg'
import openRouterLogo from '../../../../assets/providers/openrouter.svg'
import xAiLogo from '../../../../assets/providers/xai.svg'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import { SettingRow } from '../../SettingRow'
import { SelectControl, TextControl } from '../../controls'
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
  | 'bedrock'

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
    available: false
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
    available: false
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
    available: false
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
    available: false
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
    available: false
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
    available: false
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
    available: false
  },
  {
    id: 'bedrock',
    name: 'Amazon Bedrock',
    shortName: 'AWS',
    logoSrc: amazonBedrockLogo,
    category: 'cloud',
    meta: 'Enterprise cloud',
    description: 'Use supported foundation models through an AWS account.',
    capabilities: ['Chat', 'Model choice', 'Enterprise'],
    available: false
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

function providerConnected(id: ProviderId, settings: AppSettings): boolean {
  if (id === 'local') return true
  if (id === 'openai') return Boolean(settings.provider.openai.apiKey.trim())
  if (id === 'anthropic') return Boolean(settings.provider.anthropic.apiKey.trim())
  return false
}

function activeProviderDefinition(settings: AppSettings): ProviderDefinition {
  return PROVIDERS.find((provider) => provider.id === settings.provider.active) ?? PROVIDERS[0]
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
  onUpdate: (patch: DeepPartial<AppSettings>) => Promise<void>
  onOpenModels: () => void
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<ProviderId>(settings.provider.active)
  const [filter, setFilter] = useState<ProviderFilter>('all')
  const [search, setSearch] = useState('')

  const selected = PROVIDERS.find((provider) => provider.id === selectedId) ?? PROVIDERS[0]
  const active = activeProviderDefinition(settings)
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

  const activeDetail =
    settings.provider.active === 'local'
      ? `${activeModelName ?? 'No model loaded'} · Private and offline`
      : settings.provider.active === 'openai'
        ? settings.provider.openai.model
        : settings.provider.anthropic.model

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
          <span className={styles.providerReady}>
            <span /> Ready
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
                  onClick={() => {
                    if (selected.id === 'local') void onUpdate({ provider: { active: 'local' } })
                    if (selected.id === 'openai') void onUpdate({ provider: { active: 'openai' } })
                    if (selected.id === 'anthropic') {
                      void onUpdate({ provider: { active: 'anthropic' } })
                    }
                  }}
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
              <div className={styles.providerLocalPanel}>
                <span>Current local model</span>
                <strong>{activeModelName ?? 'No model loaded'}</strong>
                <p>Local models keep prompts, project context, and replies on this computer.</p>
                <Button variant="secondary" size="sm" onClick={onOpenModels}>
                  Manage local models
                </Button>
              </div>
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
                <div className={styles.providerDataNote}>
                  <Icon name="info" size={14} />
                  Messages and selected context are sent to Anthropic only while it is active.
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
