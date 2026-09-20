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
import { basename, buildRecommendedSlots } from '../settings/pages/ai-models/scoring'
import { DownloadProgress } from '../settings/pages/ai-models/RecommendedModelStrip'
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

  return (
    <div className={styles.recommendCard}>
      <div className={styles.recommendHeader}>
        <Icon name="cpu" size={16} />
        <span>No model loaded yet</span>
      </div>

      <div className={styles.recommendModel}>
        <ModelLogo family={bestOverall.model.family} size={20} />
        <div className={styles.recommendModelText}>
          <div className={styles.recommendModelName}>{bestOverall.model.name}</div>
          <div className={styles.recommendModelMeta}>
            Recommended for your hardware · needs {bestOverall.model.minRam} RAM
            {releasedLabel(bestOverall.model) ? ` · ${releasedLabel(bestOverall.model)}` : ''}
          </div>
        </div>
        {installed && <Icon name="check" size={16} className={styles.recommendCheck} />}
      </div>

      {progress?.status === 'downloading' ? (
        <DownloadProgress
          progress={progress}
          onCancel={() => cancelDownload(bestOverall.model.id)}
        />
      ) : (
        <button
          className={styles.recommendButton}
          onClick={() => void handleAction()}
          disabled={loading}
        >
          {loading ? 'Loading…' : installed ? 'Load model' : 'Download and load'}
        </button>
      )}

      <button className={styles.recommendLink} onClick={onOpenSettings}>
        Browse all models
      </button>
    </div>
  )
}
