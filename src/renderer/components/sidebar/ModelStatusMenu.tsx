import { useEffect, useRef, useState } from 'react'
import type { EngineState, ModelInfo } from '@shared/model.types'
import type { ProviderUsageSnapshot } from '@shared/providerUsage.types'
import type { ProviderSettings } from '@shared/settings.types'
import { ANTHROPIC_MODELS } from '@shared/anthropicModels'
import { OPENAI_MODELS } from '@shared/openaiModels'
import { useLiveCloudModels } from '../../lib/useLiveCloudModels'
import { useModelStore } from '../../stores/modelStore'
import { useProviderUsageStore } from '../../stores/providerUsageStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUiStore } from '../../stores/uiStore'
import { Icon } from '../Icon'
import { type StatusTone } from '../ui/StatusDot'
import { CometStatusDot } from '../ui/CometStatusDot'
import { useCometPhase } from '../ui/useCometPhase'
import styles from './ModelStatusMenu.module.css'

/** The two providers this menu offers a full quick-switch dropdown for. */
type CloudProvider = 'anthropic' | 'openai'

/**
 * Every non-local provider, including the ones this menu doesn't yet have a
 * dedicated quick-switch section for (see `AnyCloudProvider` below) — needed
 * so the footer status label/active-model check is still *correct* (not
 * misleading) when one of those is the globally active provider, even
 * though picking a different model for one still requires Settings → AI &
 * Models rather than this dropdown. Extending this dropdown with a full
 * per-provider section for all of them is a reasonable follow-up, not done
 * here.
 */
type AnyCloudProvider = Exclude<ProviderSettings['active'], 'local'>

const CLOUD_PROVIDER_LABELS: Record<AnyCloudProvider, string> = {
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
 * Resolve a model label + whether credentials are actually usable for ANY
 * non-local provider, generic across the plain `{apiKey, model}` shape most
 * providers use and Azure's distinct `{apiKey, resourceName, deploymentName}`
 * shape. Used only for the footer's correctness (label/active-model check);
 * the rich quick-switch sections below still only cover Anthropic/OpenAI.
 */
function anyCloudProviderState(
  provider: ProviderSettings | undefined,
  id: AnyCloudProvider
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

/** Stable sort putting the active item first, so it's visible without scrolling. */
function sortActiveFirst<T>(items: readonly T[], isActive: (item: T) => boolean): T[] {
  const active: T[] = []
  const rest: T[] = []
  for (const item of items) (isActive(item) ? active : rest).push(item)
  return [...active, ...rest]
}

/**
 * The model label, middle-truncated. CSS can only ellipsize one end, which
 * hides exactly the version/variant that distinguishes one build from another
 * (…-4.6-Instruct). Splitting into a truncating head and a pinned tail keeps
 * that suffix visible when the name is too long for the footer.
 */
function ModelLabel({ text }: { text: string }): JSX.Element {
  const tailLength = Math.min(12, Math.floor(text.length / 3))
  if (tailLength < 2) return <span className={styles.label}>{text}</span>
  return (
    <span className={styles.label}>
      <span className={styles.labelHead}>{text.slice(0, text.length - tailLength)}</span>
      <span className={styles.labelTail}>{text.slice(text.length - tailLength)}</span>
    </span>
  )
}

/** A small labeled progress bar — used for both the live rate-limit window and the daily cap. */
function UsageGauge({
  label,
  sublabel,
  used,
  total
}: {
  label: string
  sublabel?: string
  used: number
  total: number
}): JSX.Element {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  const tone = pct >= 100 ? 'danger' : pct >= 80 ? 'warn' : 'accent'
  return (
    <div className={styles.gauge}>
      <div className={styles.gaugeLabels}>
        <span>{label}</span>
        {sublabel && <span>{sublabel}</span>}
      </div>
      <div className={styles.gaugeTrack}>
        <div className={`${styles.gaugeFill} ${styles[tone]}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** "42s" / "3m" / "2h" until `resetAt`, or "now" once it's passed. */
function formatResetIn(resetAt: number): string {
  const seconds = Math.round((resetAt - Date.now()) / 1000)
  if (seconds <= 0) return 'now'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h`
}

/**
 * Rate-limit window (when available) and today's token tally for one cloud
 * provider — always rendered whenever that provider is active, not just once
 * a cap or a live rate-limit reading exists, so hovering a selected cloud
 * model always shows something rather than nothing until you set a cap.
 * Today's tally is a progress bar against the cap once one is set, and a
 * plain count with a "no cap set" hint before that.
 */
function ProviderUsageGauges({
  snapshot,
  dailyCap
}: {
  snapshot: ProviderUsageSnapshot | undefined
  dailyCap: number | null | undefined
}): JSX.Element {
  const todayTokens = snapshot?.todayTokens ?? 0
  return (
    <div className={styles.gauges}>
      {snapshot?.rateLimit && (
        <UsageGauge
          label={`${(snapshot.rateLimit.tokensLimit - snapshot.rateLimit.tokensRemaining).toLocaleString()} / ${snapshot.rateLimit.tokensLimit.toLocaleString()} tokens/min`}
          sublabel={`resets in ${formatResetIn(snapshot.rateLimit.resetAt)}`}
          used={snapshot.rateLimit.tokensLimit - snapshot.rateLimit.tokensRemaining}
          total={snapshot.rateLimit.tokensLimit}
        />
      )}
      {dailyCap ? (
        <UsageGauge
          label={`${todayTokens.toLocaleString()} / ${dailyCap.toLocaleString()} tokens today`}
          used={todayTokens}
          total={dailyCap}
        />
      ) : (
        <div className={styles.gaugeLabels}>
          <span>{todayTokens.toLocaleString()} tokens today</span>
          <span>no cap set</span>
        </div>
      )}
    </div>
  )
}

function statusTone(status: EngineState['status']): string {
  if (status === 'ready') return 'ready'
  if (status === 'loading') return 'busy'
  if (status === 'error') return 'error'
  return 'idle'
}

const FOOTER_STATUS_TONE: Record<string, StatusTone> = {
  ready: 'success',
  busy: 'running',
  error: 'danger',
  idle: 'neutral'
}

/** Footer status label/tone, aware of which provider is active — the local
 *  engine's `EngineState` only describes itself, so a cloud provider needs
 *  its own ready/idle read based on whether credentials are configured. This
 *  covers EVERY non-local provider (not just the two with a rich quick-switch
 *  section below) so the footer is never misleading about what's actually
 *  active, even for a provider this menu can't yet quick-switch models for. */
function providerStatus(
  engine: EngineState,
  providerActive: ProviderSettings['active'] | undefined,
  cloudState: { model: string; apiKeySet: boolean } | null
): { label: string; tone: string } {
  if (providerActive && providerActive !== 'local') {
    const providerLabel = CLOUD_PROVIDER_LABELS[providerActive]
    return cloudState?.apiKeySet
      ? { label: `${providerLabel} — ${cloudState.model}`, tone: 'ready' }
      : { label: `${providerLabel} — no API key`, tone: 'error' }
  }
  return { label: engine.model?.name ?? 'No model loaded', tone: statusTone(engine.status) }
}

/**
 * Sidebar footer status pill. With no model active anywhere (local unloaded,
 * no cloud provider configured), it's a plain link to AI & Models settings —
 * there's nothing to switch between yet. Once something is active, it
 * becomes a dropdown for quick-switching between installed local models and
 * any configured cloud provider's models, without leaving the chat.
 */
export function ModelStatusMenu(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [hovering, setHovering] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const engine = useModelStore((s) => s.engine)
  const models = useModelStore((s) => s.models)
  const pendingPath = useModelStore((s) => s.pendingPath)
  const loadModel = useModelStore((s) => s.loadModel)

  const providerActive = useSettingsStore((s) => s.settings?.provider.active)
  const provider = useSettingsStore((s) => s.settings?.provider)
  const anthropicModel = useSettingsStore((s) => s.settings?.provider.anthropic.model)
  const anthropicKeySet = useSettingsStore((s) =>
    Boolean(s.settings?.provider.anthropic.apiKey.trim())
  )
  const openaiModel = useSettingsStore((s) => s.settings?.provider.openai.model)
  const openaiKeySet = useSettingsStore((s) => Boolean(s.settings?.provider.openai.apiKey.trim()))
  // Listed models come from what the key can actually reach, so a retired model
  // stops appearing here — see `useLiveCloudModels`.
  const openAiModels = useLiveCloudModels('openai', OPENAI_MODELS).map((option) => ({
    id: option.value,
    label: option.label
  }))
  const anthropicDailyCap = useSettingsStore((s) => s.settings?.provider.anthropic.dailyTokenCap)
  const openaiDailyCap = useSettingsStore((s) => s.settings?.provider.openai.dailyTokenCap)
  const anthropicUsage = useProviderUsageStore((s) => s.snapshots.anthropic)
  const openaiUsage = useProviderUsageStore((s) => s.snapshots.openai)
  const updateSettings = useSettingsStore((s) => s.update)
  const openSettings = useUiStore((s) => s.openSettings)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const cloudState =
    providerActive && providerActive !== 'local'
      ? anyCloudProviderState(provider, providerActive)
      : null
  const footerStatus = providerStatus(engine, providerActive, cloudState)
  const footerTone = FOOTER_STATUS_TONE[footerStatus.tone]
  const dotPhase = useCometPhase(footerTone)
  const hasActiveModel = engine.status === 'ready' || Boolean(cloudState?.apiKeySet)

  // The currently active provider's own usage — what a hover glance should
  // show, since that's the model actually in use right now, not every
  // configured provider's data at once. Shown whenever a cloud model is
  // active, regardless of whether a cap or a live rate-limit reading exists
  // yet — `ProviderUsageGauges` always has at least today's token count.
  const activeCloudUsage = providerActive === 'openai' ? openaiUsage : anthropicUsage
  const activeCloudCap = providerActive === 'openai' ? openaiDailyCap : anthropicDailyCap
  const hasHoverGauge = providerActive === 'anthropic' || providerActive === 'openai'

  const close = (): void => setOpen(false)

  const isActiveLocalModel = (model: ModelInfo): boolean =>
    providerActive === 'local' && engine.status === 'ready' && engine.model?.id === model.id

  const selectLocalModel = (model: ModelInfo): void => {
    close()
    if (providerActive !== 'local') void updateSettings({ provider: { active: 'local' } })
    void loadModel(model)
  }

  const selectCloudModel = (provider: CloudProvider, modelId: string): void => {
    close()
    void updateSettings(
      provider === 'anthropic'
        ? { provider: { active: 'anthropic', anthropic: { model: modelId } } }
        : { provider: { active: 'openai', openai: { model: modelId } } }
    )
  }

  if (!hasActiveModel) {
    return (
      <button
        type="button"
        className={styles.trigger}
        onClick={() => openSettings('ai-models')}
        title="Model status — click to open AI & Models settings"
      >
        <CometStatusDot tone={footerTone} phase={dotPhase} />
        <ModelLabel text={footerStatus.label} />
      </button>
    )
  }

  return (
    <div className={styles.menu} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        title="Model status — click to switch models"
      >
        <CometStatusDot tone={footerTone} phase={dotPhase} />
        <ModelLabel text={footerStatus.label} />
        <Icon name="chevron-down" size={12} className={styles.chevron} />
      </button>

      {hovering && !open && hasHoverGauge && (
        <div className={styles.tooltip}>
          <ProviderUsageGauges snapshot={activeCloudUsage} dailyCap={activeCloudCap} />
        </div>
      )}

      {open && (
        <div className={styles.dropdown}>
          <div className={styles.sectionLabel}>Local models</div>
          {models.length === 0 ? (
            <div className={styles.empty}>No local models installed</div>
          ) : (
            sortActiveFirst(models, isActiveLocalModel).map((model) => {
              const isActive = isActiveLocalModel(model)
              const isLoading = pendingPath === model.path
              return (
                <button
                  key={model.id}
                  type="button"
                  className={styles.item}
                  disabled={isLoading}
                  onClick={() => selectLocalModel(model)}
                >
                  <Icon
                    name={isLoading ? 'refresh' : isActive ? 'check' : 'cpu'}
                    size={14}
                    className={isLoading ? styles.spinning : undefined}
                  />
                  <span className={styles.itemLabel}>{model.name}</span>
                </button>
              )
            })
          )}

          {anthropicKeySet && (
            <>
              <div className={styles.sectionLabel}>Claude</div>
              <ProviderUsageGauges snapshot={anthropicUsage} dailyCap={anthropicDailyCap} />
              {sortActiveFirst(
                ANTHROPIC_MODELS,
                (option) => providerActive === 'anthropic' && anthropicModel === option.id
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={styles.item}
                  onClick={() => selectCloudModel('anthropic', option.id)}
                >
                  <Icon
                    name={
                      providerActive === 'anthropic' && anthropicModel === option.id
                        ? 'check'
                        : 'sparkle'
                    }
                    size={14}
                  />
                  <span className={styles.itemLabel}>{option.label}</span>
                </button>
              ))}
            </>
          )}

          {openaiKeySet && (
            <>
              <div className={styles.sectionLabel}>OpenAI</div>
              <ProviderUsageGauges snapshot={openaiUsage} dailyCap={openaiDailyCap} />
              {sortActiveFirst(
                openAiModels,
                (option) => providerActive === 'openai' && openaiModel === option.id
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={styles.item}
                  onClick={() => selectCloudModel('openai', option.id)}
                >
                  <Icon
                    name={
                      providerActive === 'openai' && openaiModel === option.id ? 'check' : 'sparkle'
                    }
                    size={14}
                  />
                  <span className={styles.itemLabel}>{option.label}</span>
                </button>
              ))}
            </>
          )}

          <div className={styles.divider} />
          <button
            type="button"
            className={styles.item}
            onClick={() => {
              close()
              openSettings('ai-models')
            }}
          >
            <Icon name="settings" size={14} />
            <span className={styles.itemLabel}>Manage models…</span>
          </button>
        </div>
      )}
    </div>
  )
}
