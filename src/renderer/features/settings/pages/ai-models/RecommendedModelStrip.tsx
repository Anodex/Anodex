import { useEffect, useMemo, useState } from 'react'
import type { ModelInfo } from '@shared/model.types'
import type { HardwareInfo } from '@shared/system.types'
import type { ModelRecommendation } from '@shared/modelRecommendation'
import type { ModelReliabilityRecord } from '@shared/modelReliability.types'
import {
  RECOMMENDED_MODELS,
  recommendedModelFileName,
  type RecommendedModel
} from '@shared/recommendedModels'
import { anodex } from '../../../../lib/anodex'
import { useModelStore } from '../../../../stores/modelStore'
import { formatBytes } from '../../../../lib/format'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import { ModelLogo } from '../../../../components/ModelLogo'
import { Spinner } from '../../../../components/ui/Spinner'
import { basename, buildRecommendedSlots, mergeCatalogs } from './scoring'
import styles from './AiModelsSettings.module.css'

/** The 5 best local-model picks for this hardware — Best Overall/Coding/Agent/Fastest/Large Context. */
export function RecommendedModelStrip({
  hardware,
  loading,
  recommendation,
  installedModels,
  reliability
}: {
  hardware: HardwareInfo | null
  loading: boolean
  recommendation: ModelRecommendation | null
  installedModels: ModelInfo[]
  reliability: Map<string, ModelReliabilityRecord>
}): JSX.Element {
  const downloads = useModelStore((s) => s.downloads)
  const downloadModel = useModelStore((s) => s.downloadModel)
  const cancelDownload = useModelStore((s) => s.cancelDownload)

  // Auto-populated from Hugging Face on mount (not a manual search, like
  // `DiscoverModelsPanel` — this strip is meant to always reflect current
  // models without the user asking). Failure or an offline machine just
  // leaves the static catalog as the only source, so this never blocks or
  // breaks the recommendation strip.
  const [liveModels, setLiveModels] = useState<RecommendedModel[]>([])
  useEffect(() => {
    let cancelled = false
    void anodex.models.fetchTopModels().then((result) => {
      if (!cancelled && result.ok) setLiveModels(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const catalog = useMemo(() => mergeCatalogs(RECOMMENDED_MODELS, liveModels), [liveModels])
  const slots = useMemo(
    () =>
      buildRecommendedSlots(hardware, recommendation, { installedModels, reliability }, catalog),
    [hardware, recommendation, installedModels, reliability, catalog]
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
            Multiple choices stay visible so Anodex never looks locked to one model family. Kept
            current automatically from Hugging Face alongside Anodex&apos;s own hand-tested picks.
          </p>
        </div>
      </div>

      {loading || !hardware ? (
        <div className={styles.hardwareLoading}>
          <Spinner size={16} />
          <span>Detecting hardware…</span>
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
                    <span className={styles.recIcon}>
                      <ModelLogo family={slot.model.family} size={16} />
                    </span>
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

                {isDownloaded ? (
                  <div className={styles.downloadedBadge}>
                    <Icon name="check" size={14} />
                    Downloaded
                  </div>
                ) : progress?.status === 'downloading' ? (
                  <DownloadProgress
                    progress={progress}
                    onCancel={() => cancelDownload(slot.model.id)}
                  />
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft={<Icon name="download" size={14} />}
                    onClick={() => void downloadModel(slot.model)}
                  >
                    {progress?.status === 'error' ? 'Retry download' : 'Download'}
                  </Button>
                )}
                {progress?.status === 'error' && (
                  <p className={styles.errorText}>{progress.error ?? 'Download failed.'}</p>
                )}
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
      <span className={styles.progressText}>
        {formatBytes(progress.receivedBytes)}
        {progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''}
      </span>
      <button
        type="button"
        className={styles.cancelButton}
        onClick={onCancel}
        title="Cancel download"
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  )
}
