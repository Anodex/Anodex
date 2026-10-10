import { useEffect, useMemo, useState } from 'react'
import type { HardwareInfo } from '@shared/system.types'
import { recommendedModelFileName, type RecommendedModel } from '@shared/recommendedModels'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useUiStore } from '../../stores/uiStore'
import { anodex } from '../../lib/anodex'
import { AnodexLogo } from '../../components/AnodexLogo'
import { Icon } from '../../components/Icon'
import { ModelLogo } from '../../components/ModelLogo'
import { formatBytes } from '../../lib/format'
import { basename, buildRecommendedSlots } from '../settings/pages/ai-models/scoring'
import { DownloadProgress } from '../settings/pages/ai-models/RecommendedModelStrip'
import { Button } from '../../components/ui/Button'
import { DownloadTour } from './DownloadTour'
import { downloadShortfallBytes } from './diskSpace'
import { timeLeftLabel, useDownloadRate } from './downloadRate'
import styles from './ChatEmptyState.module.css'

const SUGGESTIONS = [
  'Explain this error and how to fix it',
  'Write a TypeScript function to debounce calls',
  'Refactor this snippet to be more readable',
  'Summarize how async/await works'
]

/**
 * When the model came out, for the one card that offers a single model as the
 * answer. A first-time user has no way to tell a current model from one two
 * generations old, and the name alone does not say — this does.
 */
function releasedLabel(model: RecommendedModel): string | null {
  if (!model.publishedAt) return null
  const published = new Date(model.publishedAt)
  if (Number.isNaN(published.getTime())) return null
  return `released ${published.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`
}

interface SpecTile {
  icon: 'cpu' | 'layers' | 'monitor' | 'archive'
  label: string
  value: string
  detail?: string
  /** The untrimmed hardware name, for the hover tooltip. */
  full?: string
  /** Shown in the warning colour: this is what stops the recommendation. */
  warning?: boolean
}

/**
 * Hardware names as the OS reports them carry filler that pushes the part that
 * identifies the chip off the end of a small tile: "12-Core Processor" repeats
 * the core count shown above it, Intel adds trademark marks and a clock, and Mesa
 * appends its driver in parentheses.
 */
function shortHardwareName(name: string): string {
  return name
    .replace(/\((R|TM)\)/gi, '')
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/\s+@\s*[\d.]+\s*GHz$/i, '')
    .replace(/\s+\d+-Core Processor$/i, '')
    .replace(/\s+(Processor|CPU)$/i, '')
    .trim()
}

/**
 * What the recommendation was made against. "Recommended for your hardware"
 * asks to be taken on trust; showing the machine it measured lets a first-time
 * user check it, and saying what the model needs of memory and disk beside what
 * the machine has explains the pick before they commit to a large download.
 */
function specTiles(hardware: HardwareInfo, model: RecommendedModel): SpecTile[] {
  const tiles: SpecTile[] = [
    {
      icon: 'cpu',
      label: 'Processor',
      value: `${hardware.cores} cores`,
      detail: shortHardwareName(hardware.cpu),
      full: hardware.cpu
    },
    {
      icon: 'layers',
      label: 'Memory',
      value: hardware.ram,
      detail: `This model needs ${model.minRam}`
    }
  ]
  const gpu = hardware.gpu ? shortHardwareName(hardware.gpu) : undefined
  if (hardware.unifiedMemory) {
    tiles.push({
      icon: 'monitor',
      label: 'Graphics',
      value: 'Unified memory',
      detail: gpu,
      full: hardware.gpu ?? undefined
    })
  } else if (hardware.gpu) {
    tiles.push({
      icon: 'monitor',
      label: 'Graphics',
      value: hardware.vram ? `${hardware.vram} VRAM` : 'Detected',
      detail: gpu,
      full: hardware.gpu
    })
  } else {
    tiles.push({
      icon: 'monitor',
      label: 'Graphics',
      value: 'CPU only',
      detail: 'No GPU detected'
    })
  }
  if (hardware.storageFree) {
    const short = downloadShortfallBytes(hardware, model)
    tiles.push({
      icon: 'archive',
      label: 'Free space',
      value: hardware.storageFree,
      detail: short
        ? `Needs ${model.approxSize} · ${formatBytes(short)} short`
        : `This model needs ${model.approxSize}`,
      warning: short > 0
    })
  }
  return tiles
}

/** Shown when the active conversation has no messages yet. */
export function ChatEmptyState(): JSX.Element {
  const ready = useModelStore((s) => s.engine.status === 'ready')
  const sendMessage = useChatStore((s) => s.sendMessage)
  const openSettings = useUiStore((s) => s.openSettings)

  return (
    <div className={styles.empty}>
      <div className={styles.hero}>
        <AnodexLogo variant="icon" size={72} className={styles.heroIcon} />
        <h2 className={styles.heading}>How can I help you build?</h2>
        <p className={styles.subtitle}>
          Anodex is a local-first assistant for coding help and general chat.
        </p>
      </div>

      {ready ? (
        <div className={styles.suggestions}>
          <div className={styles.suggestionsLabel}>Try a quick prompt</div>
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              className={styles.suggestion}
              onClick={() => void sendMessage(suggestion)}
            >
              <Icon name="sparkle" size={15} />
              <span>{suggestion}</span>
            </button>
          ))}
        </div>
      ) : (
        <NoModelOnboarding onOpenSettings={() => openSettings('ai-models')} />
      )}
    </div>
  )
}

/** First-run path for a model-less chat: one concrete recommended model to
 *  download and load, instead of just pointing at Settings and leaving the
 *  user to figure out which model and whether it'll even run on their
 *  machine. Falls back to the plain "open settings" callout if hardware
 *  detection fails or nothing in the catalog fits. */
function NoModelOnboarding({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element {
  const models = useModelStore((s) => s.models)
  const downloads = useModelStore((s) => s.downloads)
  const downloadModel = useModelStore((s) => s.downloadModel)
  const cancelDownload = useModelStore((s) => s.cancelDownload)
  const loadModel = useModelStore((s) => s.loadModel)
  const pendingPath = useModelStore((s) => s.pendingPath)

  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [loadingHardware, setLoadingHardware] = useState(true)
  // The same live pool Settings uses, and now the only pool: the built-in
  // list this used to fall back on was a generation behind the moment a new
  // model shipped, which is the one moment where being current matters most.
  const [liveModels, setLiveModels] = useState<RecommendedModel[]>([])
  const [loadingModels, setLoadingModels] = useState(true)

  useEffect(() => {
    let cancelled = false
    void anodex.system.getHardwareInfo().then((info) => {
      if (!cancelled) {
        setHardware(info)
        setLoadingHardware(false)
      }
    })
    // Offline, or Hugging Face unreachable: there is nothing to recommend,
    // because every model on offer has to be downloaded. The card says so
    // rather than naming something the machine cannot fetch.
    void anodex.models.fetchTopModels().then((result) => {
      if (cancelled) return
      if (result.ok) setLiveModels(result.value)
      setLoadingModels(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const bestOverall = useMemo(() => {
    if (loadingHardware) return null
    return buildRecommendedSlots(hardware, undefined, liveModels).find(
      (slot) => slot.id === 'overall'
    )
  }, [hardware, loadingHardware, liveModels])

  if (loadingHardware || loadingModels) {
    return (
      <div className={styles.callout}>
        <span className={styles.calloutIcon}>
          <Icon name="cpu" size={20} />
        </span>
        <div className={styles.calloutBody}>
          <div className={styles.calloutTitle}>Checking your hardware…</div>
        </div>
      </div>
    )
  }

  if (!bestOverall) {
    return (
      <div className={styles.callout}>
        <span className={styles.calloutIcon}>
          <Icon name="cpu" size={20} />
        </span>
        <div className={styles.calloutBody}>
          <div className={styles.calloutTitle}>No model loaded</div>
          <div className={styles.calloutText}>
            {liveModels.length === 0
              ? 'Anodex reads the current model list from Hugging Face and could not reach it. Downloading a model needs a connection — or open Settings to load a GGUF you already have.'
              : 'Load a local model to start chatting — it runs entirely on your machine.'}
          </div>
        </div>
        <button className={styles.calloutButton} onClick={onOpenSettings}>
          Open Settings
        </button>
      </div>
    )
  }

  const fileName = recommendedModelFileName(bestOverall.model).toLowerCase()
  const installed = models.find((model) => basename(model.path).toLowerCase() === fileName)
  const progress = downloads[bestOverall.model.id]
  const loading = installed && pendingPath === installed.path
  // A model already on disk needs no room; one that is not, and would not fit,
  // must not be offered as the first thing a new user does.
  const spaceShort = installed ? 0 : downloadShortfallBytes(hardware, bestOverall.model)

  const handleAction = async (): Promise<void> => {
    if (installed) {
      void loadModel(installed)
      return
    }
    await downloadModel(bestOverall.model)
    const match = useModelStore
      .getState()
      .models.find((model) => basename(model.path).toLowerCase() === fileName)
    if (match) void loadModel(match)
  }

  const released = releasedLabel(bestOverall.model)

  // The download is minutes long and nothing else can happen yet, so the card
  // spends it on the tour, keeping only the progress that says how long is left.
  if (progress?.status === 'downloading') {
    return (
      <div className={styles.recommendCard}>
        <DownloadTour modelName={bestOverall.model.name} />
        <DownloadStatus
          name={bestOverall.model.name}
          progress={progress}
          onCancel={() => cancelDownload(bestOverall.model.id)}
        />
      </div>
    )
  }

  return (
    <div className={styles.recommendCard}>
      <div className={styles.recommendHeader}>
        <span className={styles.recommendHeaderIcon}>
          <Icon name="cpu" size={16} />
        </span>
        <div>
          <div className={styles.recommendTitle}>Pick a model to get started</div>
          <div className={styles.recommendSubtitle}>
            Models run on this machine. Nothing you type leaves it.
          </div>
        </div>
      </div>

      {hardware && (
        <section className={styles.specs} aria-label="Your system">
          <div className={styles.sectionLabel}>Your system</div>
          <div className={styles.specGrid}>
            {specTiles(hardware, bestOverall.model).map((tile) => (
              <div
                key={tile.label}
                className={`${styles.specTile} ${tile.warning ? styles.specTileWarning : ''}`}
                title={tile.full}
              >
                <div className={styles.specLabel}>
                  <Icon name={tile.icon} size={12} />
                  {tile.label}
                </div>
                <div className={styles.specValue}>{tile.value}</div>
                {tile.detail && <div className={styles.specDetail}>{tile.detail}</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      <section aria-label="Recommended model">
        <div className={styles.sectionLabel}>Recommended for your hardware</div>
        <div className={styles.recommendModel}>
          <ModelLogo family={bestOverall.model.family} size={24} />
          <div className={styles.recommendModelText}>
            <div className={styles.recommendModelName}>{bestOverall.model.name}</div>
            <div className={styles.recommendModelMeta}>
              {[bestOverall.model.description.replace(/\.$/, ''), released]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
          {installed && <Icon name="check" size={16} className={styles.recommendCheck} />}
        </div>
      </section>

      {spaceShort ? (
        <>
          <Button variant="secondary" className={styles.recommendButton} disabled>
            Not enough space
          </Button>
          <p className={styles.spaceNote} role="status">
            Free {formatBytes(spaceShort)} more on this drive, or pick a smaller model.
          </p>
        </>
      ) : (
        <Button
          variant="primary"
          className={styles.recommendButton}
          iconLeft={installed ? undefined : <Icon name="download" size={16} />}
          loading={loading}
          onClick={() => void handleAction()}
        >
          {loading ? 'Loading…' : installed ? 'Load model' : 'Download and load'}
        </Button>
      )}

      <Button variant="ghost" size="sm" className={styles.recommendLink} onClick={onOpenSettings}>
        {spaceShort ? 'See models that fit' : 'Browse all models'}
      </Button>
    </div>
  )
}

/** The download's progress, with the speed and time left a long wait needs. */
function DownloadStatus({
  name,
  progress,
  onCancel
}: {
  name: string
  progress: { receivedBytes: number; totalBytes: number | null }
  onCancel: () => void
}): JSX.Element {
  const rate = useDownloadRate(progress.receivedBytes, progress.totalBytes)
  return (
    <section aria-label="Download progress">
      <div className={styles.downloadHeader}>
        <span className={styles.downloadName}>Downloading {name}</span>
        <span className={styles.downloadRate}>
          {rate
            ? [
                `${formatBytes(rate.bytesPerSecond)}/s`,
                rate.secondsLeft !== null ? timeLeftLabel(rate.secondsLeft) : null
              ]
                .filter(Boolean)
                .join(' · ')
            : 'Measuring speed…'}
        </span>
      </div>
      <DownloadProgress progress={progress} onCancel={onCancel} />
    </section>
  )
}
