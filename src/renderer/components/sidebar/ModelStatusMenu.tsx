import { useEffect, useRef, useState } from 'react'
import type { EngineState, ModelInfo } from '@shared/model.types'
import type { ProviderUsageSnapshot } from '@shared/providerUsage.types'
import { ANTHROPIC_MODELS } from '@shared/anthropicModels'
import { OPENAI_MODELS } from '@shared/openaiModels'
import { useModelStore } from '../../stores/modelStore'
import { useProviderUsageStore } from '../../stores/providerUsageStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUiStore } from '../../stores/uiStore'
import { Icon } from '../Icon'
import { type StatusTone } from '../ui/StatusDot'
import { CometStatusDot } from '../ui/CometStatusDot'
import { useCometPhase } from '../ui/useCometPhase'
import styles from './ModelStatusMenu.module.css'

type CloudProvider = 'anthropic' | 'openai'

const CLOUD_PROVIDER_LABELS: Record<CloudProvider, string> = {
  anthropic: 'Claude',
  openai: 'OpenAI'
}

/** Stable sort putting the active item first, so it's visible without scrolling. */
function sortActiveFirst<T>(items: readonly T[], isActive: (item: T) => boolean): T[] {
  const active: T[] = []
  const rest: T[] = []
  for (const item of items) (isActive(item) ? active : rest).push(item)
  return [...active, ...rest]
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
 *  its own ready/idle read based on whether an API key is configured. */
function providerStatus(
  engine: EngineState,
  providerActive: 'local' | CloudProvider | undefined,
  cloudModel: string | undefined,
  cloudApiKeySet: boolean
): { label: string; tone: string } {
  if (providerActive === 'anthropic' || providerActive === 'openai') {
    const providerLabel = CLOUD_PROVIDER_LABELS[providerActive]
    return cloudApiKeySet
      ? { label: `${providerLabel} — ${cloudModel ?? ''}`, tone: 'ready' }
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
  const anthropicModel = useSettingsStore((s) => s.settings?.provider.anthropic.model)
  const anthropicKeySet = useSettingsStore((s) =>
    Boolean(s.settings?.provider.anthropic.apiKey.trim())
  )
  const openaiModel = useSettingsStore((s) => s.settings?.provider.openai.model)
  const openaiKeySet = useSettingsStore((s) => Boolean(s.settings?.provider.openai.apiKey.trim()))
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

  const cloudModel = providerActive === 'openai' ? openaiModel : anthropicModel
  const cloudApiKeySet = providerActive === 'openai' ? openaiKeySet : anthropicKeySet
  const footerStatus = providerStatus(engine, providerActive, cloudModel, cloudApiKeySet)
  const footerTone = FOOTER_STATUS_TONE[footerStatus.tone]
  const dotPhase = useCometPhase(footerTone)
  const hasActiveModel =
    engine.status === 'ready' ||
    ((providerActive === 'anthropic' || providerActive === 'openai') && cloudApiKeySet)

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
        <span className={styles.label}>{footerStatus.label}</span>
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
        <span className={styles.label}>{footerStatus.label}</span>
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
                OPENAI_MODELS,
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
