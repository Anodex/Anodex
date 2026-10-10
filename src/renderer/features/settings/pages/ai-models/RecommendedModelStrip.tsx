import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelDownloadProgress, ModelInfo } from '@shared/model.types'
import type { HardwareInfo } from '@shared/system.types'
import type { ModelReliabilityRecord } from '@shared/modelReliability.types'
import {
  recommendedModelFileName,
  type ModelFamily,
  type RecommendedModel
} from '@shared/recommendedModels'
import { anodex } from '../../../../lib/anodex'
import { useModelStore } from '../../../../stores/modelStore'
import { formatBytes } from '../../../../lib/format'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import { ModelLogo } from '../../../../components/ModelLogo'
import { Spinner } from '../../../../components/ui/Spinner'
import { basename, buildRecommendedSlots } from './scoring'
import styles from './AiModelsSettings.module.css'

/** The 5 best local-model picks for this hardware — Best Overall/Coding/Agent/Fastest/Large Context. */
export function RecommendedModelStrip({
  hardware,
  loading,
  installedModels,
  reliability
}: {
  hardware: HardwareInfo | null
  loading: boolean
  installedModels: ModelInfo[]
  reliability: Map<string, ModelReliabilityRecord>
}): JSX.Element {
  const downloads = useModelStore((s) => s.downloads)

  // Auto-populated from Hugging Face on mount (not a manual search, like
  // `DiscoverModelsPanel` — this strip is meant to always reflect current
  // models without the user asking). A failed fetch falls back to the last
  // list that arrived, kept on disk; with no network and no cache there is
  // nothing honest to show, since every model here has to be downloaded.
  const [liveModels, setLiveModels] = useState<RecommendedModel[]>([])
  const [liveState, setLiveState] = useState<'loading' | 'live' | 'offline'>('loading')
  useEffect(() => {
    let cancelled = false
    void anodex.models.fetchTopModels().then((result) => {
      if (cancelled) return
      if (result.ok && result.value.length > 0) {
        setLiveModels(result.value)
        setLiveState('live')
      } else {
        setLiveState('offline')
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const slots = useMemo(
    () => buildRecommendedSlots(hardware, { installedModels, reliability }, liveModels),
    [hardware, installedModels, reliability, liveModels]
  )
  const localFileNames = useMemo(
    () => new Set(installedModels.map((model) => basename(model.path).toLowerCase())),
    [installedModels]
  )

  return (
    <section className={styles.sectionFlush}>
      <div className={styles.sectionTitleRow}>
        <div>
          <p className={styles.sectionKicker}>Recommended</p>
          <h2 className={styles.sectionTitle}>Best local models for this computer</h2>
          <p className={styles.sectionDesc}>
            {liveState === 'offline'
              ? 'Could not reach Hugging Face. Downloading a model needs a connection anyway, so reopen this page once you are online.'
              : 'Picked from what is currently popular on Hugging Face and fits this computer, so a new model generation shows up here without waiting for an Anodex update.'}
          </p>
        </div>
      </div>

      {loading || !hardware ? (
        <div className={styles.hardwareLoading}>
          <Spinner size={16} />
          <span>Detecting hardware…</span>
        </div>
      ) : slots.length === 0 ? (
        <div className={styles.hardwareLoading}>
          <Icon name="cpu" size={16} />
          <span>
            {liveState === 'live'
              ? 'Nothing currently popular on Hugging Face fits this computer safely. Add a smaller GGUF only if you know it suits this hardware.'
              : 'No suggestions yet — Anodex reads the current model list from Hugging Face, and downloading one needs a connection. You can still load a GGUF you already have.'}
          </span>
        </div>
      ) : (
        <div className={styles.recGrid}>
          {slots.map((slot) => {
            const isDownloaded = localFileNames.has(
              recommendedModelFileName(slot.model).toLowerCase()
            )
            const progress = downloads[slot.model.id]

            return (
              <article key={slot.id} className={styles.recCard}>
                <div className={styles.recCardTop}>
                  <div className={styles.recLabelGroup}>
                    <ModelDownloadIcon
                      family={slot.model.family}
                      size={16}
                      status={progress?.status}
                    />
                    <span className={styles.recLabel}>{slot.label}</span>
                  </div>
                  <ScoreBadge score={slot.score} />
                </div>
                <h3 className={styles.recName}>{slot.model.name}</h3>
                <p className={styles.recDescription}>{slot.note}</p>
                <div className={styles.recTags}>
                  {slot.model.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className={styles.tag}>
                      {tag}
                    </span>
                  ))}
                </div>
                <div className={styles.recSpecs}>
                  <span>{slot.model.approxSize}</span>
                  <span className={styles.dotSep} />
                  <span>{slot.model.minRam} RAM</span>
                </div>

                <DownloadAction model={slot.model} installed={isDownloaded} />
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

function ScoreBadge({ score }: { score: number }): JSX.Element {
  return <span className={styles.scoreBadge}>{score}</span>
}

/**
 * True for the remainder of this component's lifetime once a download
 * status flips to 'done' — never fires on mount for an already-downloaded
 * model (no progress entry, or a stale one left over from a previous
 * session), only on the live transition. `useRef`'s initial value keys off
 * the same first-render status, so an already-'done' entry on mount is
 * correctly treated as "not a new arrival."
 */
function useJustCompleted(status: ModelDownloadProgress['status'] | undefined): boolean {
  const wasDoneRef = useRef(status === 'done')
  const [justCompleted, setJustCompleted] = useState(false)
  useEffect(() => {
    const isDone = status === 'done'
    if (isDone && !wasDoneRef.current) setJustCompleted(true)
    wasDoneRef.current = isDone
  }, [status])
  return justCompleted
}

/**
 * The model-family logo shown on recommendation/discover cards, wrapped
 * with the download lifecycle's "soul": a breathing halo while the download
 * is active, and a one-shot bloom the instant it finishes (never replayed
 * on remount — see `useJustCompleted` above). Exported for reuse by
 * `DiscoverModelsPanel`, same reasoning as `DownloadProgress` below.
 */
export function ModelDownloadIcon({
  family,
  size = 16,
  status
}: {
  family: ModelFamily
  size?: number
  status: ModelDownloadProgress['status'] | undefined
}): JSX.Element {
  const justCompleted = useJustCompleted(status)
  const className = [
    styles.recIcon,
    status === 'downloading' ? styles.recIconActive : '',
    justCompleted ? styles.recIconArrived : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span className={className}>
      <ModelLogo family={family} size={size} />
    </span>
  )
}

/**
 * A model card's download control, the same on every card that offers one:
 * Downloaded, the progress bar while it runs, or the button — which resumes,
 * and says how much is already here, when an earlier download was cancelled,
 * failed, or cut off by quitting.
 */
export function DownloadAction({
  model,
  installed
}: {
  model: RecommendedModel
  installed: boolean
}): JSX.Element {
  const progress = useModelStore((s) => s.downloads[model.id])
  const partialBytes = useModelStore((s) => s.partials[model.id] ?? 0)
  const downloadModel = useModelStore((s) => s.downloadModel)
  const cancelDownload = useModelStore((s) => s.cancelDownload)
  const refreshPartials = useModelStore((s) => s.refreshPartials)

  useEffect(() => {
    if (!installed) void refreshPartials([model])
  }, [installed, model, refreshPartials])

  if (installed) {
    return (
      <div className={styles.downloadedBadge}>
        <Icon name="check" size={14} />
        Downloaded
      </div>
    )
  }
  if (progress?.status === 'downloading') {
    return <DownloadProgress progress={progress} onCancel={() => cancelDownload(model.id)} />
  }
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        iconLeft={<Icon name="download" size={14} />}
        onClick={() => void downloadModel(model)}
      >
        {partialBytes > 0
          ? 'Resume download'
          : progress?.status === 'error'
            ? 'Retry download'
            : 'Download'}
      </Button>
      {progress?.status === 'error' && (
        <p className={styles.errorText}>{progress.error ?? 'Download failed.'}</p>
      )}
      {partialBytes > 0 && <PartialDownloadNote model={model} bytes={partialBytes} />}
    </>
  )
}

/**
 * How much of a stopped download is already on disk, and the way to give the
 * space back. Kept parts used to be deleted on Cancel precisely so nothing sat
 * on disk unseen; now that they are kept, this is where they are seen.
 */
export function PartialDownloadNote({
  model,
  bytes,
  className
}: {
  model: RecommendedModel
  bytes: number
  className?: string
}): JSX.Element {
  const discardPartial = useModelStore((s) => s.discardPartial)
  return (
    <p className={`${styles.partialNote} ${className ?? ''}`}>
      <span>
        {formatBytes(bytes)} of {model.approxSize} already downloaded
      </span>
      <button
        type="button"
        className={styles.partialDiscard}
        onClick={() => void discardPartial(model)}
      >
        Discard
      </button>
    </p>
  )
}

/** Exported for reuse by `DiscoverModelsPanel`, which shows the same download-in-progress UI. */
export function DownloadProgress({
  progress,
  onCancel
}: {
  progress: { receivedBytes: number; totalBytes: number | null }
  onCancel: () => void
}): JSX.Element {
  const pct =
    progress.totalBytes && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
      : null

  return (
    <div className={styles.progressRow}>
      <div className={styles.progressTrack}>
        <div className={styles.progressFill} style={{ width: `${pct ?? 0}%` }} />
      </div>
      <div className={styles.progressMeta}>
        <span className={styles.progressText}>
          {formatBytes(progress.receivedBytes)}
          {progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''}
        </span>
        <button
          type="button"
          className={styles.cancelButton}
          onClick={onCancel}
          aria-label="Stop download"
          title="Stop download. What has arrived is kept, so it can resume."
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    </div>
  )
}
