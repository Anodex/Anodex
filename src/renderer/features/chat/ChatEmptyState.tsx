import { useEffect, useMemo, useState } from 'react'
import type { HardwareInfo } from '@shared/system.types'
import { recommendModel } from '@shared/modelRecommendation'
import { recommendedModelFileName } from '@shared/recommendedModels'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useUiStore } from '../../stores/uiStore'
import { anodex } from '../../lib/anodex'
import { AnodexLogo } from '../../components/AnodexLogo'
import { Icon } from '../../components/Icon'
import { ModelLogo } from '../../components/ModelLogo'
import { basename, buildRecommendedSlots } from '../settings/pages/ai-models/scoring'
import { DownloadProgress } from '../settings/pages/ai-models/RecommendedModelStrip'
import { ChatConstellation } from './ChatConstellation'
import styles from './ChatEmptyState.module.css'

const SUGGESTIONS = [
  'Explain this error and how to fix it',
  'Write a TypeScript function to debounce calls',
  'Refactor this snippet to be more readable',
  'Summarize how async/await works'
]

/** Shown when the active conversation has no messages yet. */
export function ChatEmptyState(): JSX.Element {
  const ready = useModelStore((s) => s.engine.status === 'ready')
  const sendMessage = useChatStore((s) => s.sendMessage)
  const openSettings = useUiStore((s) => s.openSettings)

  return (
    <div className={styles.empty}>
      <ChatConstellation />
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

  useEffect(() => {
    let cancelled = false
    void anodex.system.getHardwareInfo().then((info) => {
      if (!cancelled) {
        setHardware(info)
        setLoadingHardware(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const recommendation = hardware
    ? recommendModel({
        ramBytes: hardware.ramBytes,
        vramBytes: hardware.vramBytes,
        unified: hardware.unifiedMemory
      })
    : null

  const bestOverall = useMemo(() => {
    if (loadingHardware) return null
    return buildRecommendedSlots(hardware, recommendation).find((slot) => slot.id === 'overall')
  }, [hardware, recommendation, loadingHardware])

  if (loadingHardware) {
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
            Load a local model to start chatting — it runs entirely on your machine.
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
