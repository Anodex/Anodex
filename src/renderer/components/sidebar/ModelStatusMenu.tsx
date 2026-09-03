import { Fragment, useEffect, useRef, useState } from 'react'
import type { EngineState, ModelInfo } from '@shared/model.types'
import type { ProviderUsageSnapshot } from '@shared/providerUsage.types'
import type { ProviderSettings } from '@shared/settings.types'
import { OPENAI_MODELS } from '@shared/openaiModels'
import {
  CLOUD_PROVIDER_IDS,
  CLOUD_PROVIDER_LABELS,
  cloudProviderModels,
  cloudProviderState,
  type CloudProviderId
} from '@shared/providerCatalog'
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
 *  its own ready/idle read based on whether credentials are configured. */
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
 * Sidebar footer status pill. With nothing installed and nothing linked, it's
 * a plain link to AI & Models settings — there is genuinely nothing to switch
 * between. Otherwise it is a dropdown over every installed local model and
 * every linked cloud provider's models, without leaving the chat.
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
  // Listed models come from what the key can actually reach, so a retired model
  // stops appearing here — see `useLiveCloudModels`. Only OpenAI can list; the
  // hook returns the curated catalog unchanged for everyone else, so calling it
  // once here and substituting below keeps one code path for all providers.
  const openAiModels = useLiveCloudModels('openai', OPENAI_MODELS)
  const usage = useProviderUsageStore((s) => s.snapshots)
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
      ? cloudProviderState(provider, providerActive)
      : null
  const footerStatus = providerStatus(engine, providerActive, cloudState)
  const footerTone = FOOTER_STATUS_TONE[footerStatus.tone]
  const dotPhase = useCometPhase(footerTone)
  const hasActiveModel = engine.status === 'ready' || Boolean(cloudState?.apiKeySet)

  /**
   * Every linked provider, active one first.
   *
   * This menu used to hardcode two sections, Claude and OpenAI, while eleven
   * providers are configurable — so linking DeepSeek in Settings left no way
   * to switch to it from the place you switch models. Driven off the shared
   * catalog now, a provider added there appears here without touching this
   * file.
   */
  const linkedProviders = CLOUD_PROVIDER_IDS.filter(
    (id) => cloudProviderState(provider, id)?.apiKeySet
  ).sort((a, b) => Number(b === providerActive) - Number(a === providerActive))

  /**
   * Whether the dropdown has anything to offer. Not the same question as
   * whether something is *active*: with local selected and nothing loaded, a
   * linked cloud provider is still one click away, and the menu used to
   * collapse to a dead link that only opened Settings.
   */
  const hasSomethingToSwitchTo = models.length > 0 || linkedProviders.length > 0

  const dailyCapFor = (id: CloudProviderId): number | null =>
    id === 'azure'
      ? (provider?.azure.dailyTokenCap ?? null)
      : (provider?.[id].dailyTokenCap ?? null)

  // The active provider's own usage, for the hover glance. Only providers whose
  // SDK exposes usage have a snapshot; the rest simply get no gauge rather than
  // an empty one implying zero.
  const activeCloudUsage =
    providerActive && providerActive !== 'local' ? usage[providerActive] : undefined
  const hasHoverGauge = Boolean(activeCloudUsage)

  const close = (): void => setOpen(false)

  const isActiveLocalModel = (model: ModelInfo): boolean =>
    providerActive === 'local' && engine.status === 'ready' && engine.model?.id === model.id

  const selectLocalModel = (model: ModelInfo): void => {
    close()
    if (providerActive !== 'local') void updateSettings({ provider: { active: 'local' } })
    void loadModel(model)
  }

  const selectCloudModel = (id: CloudProviderId, modelId: string): void => {
    close()
    // Azure's model *is* its deployment name, configured in Settings, so
    // choosing it here switches provider without rewriting that field.
    void updateSettings(
      id === 'azure'
        ? { provider: { active: 'azure' } }
        : { provider: { active: id, [id]: { model: modelId } } }
    )
  }

  if (!hasActiveModel && !hasSomethingToSwitchTo) {
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
          <ProviderUsageGauges
            snapshot={activeCloudUsage}
            dailyCap={
              providerActive && providerActive !== 'local' ? dailyCapFor(providerActive) : null
            }
          />
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

          {linkedProviders.map((id) => {
            const state = cloudProviderState(provider, id)
            const catalog = cloudProviderModels(id)
            const snapshot = usage[id]
            const options =
              catalog === null
                ? // Azure has no catalog: its deployment name is the model, so
                  // the single configured one is all there is to offer.
                  [{ id: state?.model ?? '', label: state?.model || 'Configured deployment' }]
                : id === 'openai'
                  ? openAiModels.map((option) => ({ id: option.value, label: option.label }))
                  : catalog.map((model) => ({ id: model.id, label: model.label }))

            return (
              <Fragment key={id}>
                <div className={styles.sectionLabel}>{CLOUD_PROVIDER_LABELS[id]}</div>
                {snapshot && <ProviderUsageGauges snapshot={snapshot} dailyCap={dailyCapFor(id)} />}
                {sortActiveFirst(
                  options,
                  (option) => providerActive === id && state?.model === option.id
                ).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={styles.item}
                    onClick={() => selectCloudModel(id, option.id)}
                  >
                    <Icon
                      name={
                        providerActive === id && state?.model === option.id ? 'check' : 'sparkle'
                      }
                      size={14}
                    />
                    <span className={styles.itemLabel}>{option.label}</span>
                  </button>
                ))}
              </Fragment>
            )
          })}

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
