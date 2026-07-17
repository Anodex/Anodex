import { useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ModelInfo } from '@shared/model.types'
import { recommendedModelFileName, type RecommendedModel } from '@shared/recommendedModels'
import { anodex } from '../../../../lib/anodex'
import { useModelStore } from '../../../../stores/modelStore'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import { Spinner } from '../../../../components/ui/Spinner'
import { basename } from './scoring'
import { DownloadProgress, ModelDownloadIcon } from './RecommendedModelStrip'
import styles from './AiModelsSettings.module.css'

/** `154325` → `154.3k`; kept local since nothing else in the app needs a compact-count formatter yet. */
function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/**
 * Live search across Hugging Face's GGUF catalog, sitting alongside the
 * hand-curated `RecommendedModelStrip`. Deliberately manual (a search box,
 * not an auto-fetch on mount) — an online lookup shouldn't fire just because
 * the user opened a local-first settings page, and results are explicitly
 * labelled as unverified since nobody has vetted their quality or
 * tool-calling support the way the curated catalog's entries are.
 */
export function DiscoverModelsPanel({
  installedModels
}: {
  installedModels: ModelInfo[]
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RecommendedModel[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const downloads = useModelStore((s) => s.downloads)
  const downloadModel = useModelStore((s) => s.downloadModel)
  const cancelDownload = useModelStore((s) => s.cancelDownload)
  const localFileNames = useMemo(
    () => new Set(installedModels.map((model) => basename(model.path).toLowerCase())),
    [installedModels]
  )

  const runSearch = async (): Promise<void> => {
    const trimmed = query.trim()
    if (!trimmed || searching) return
    setSearching(true)
    setError(null)
    const result = await anodex.models.discover(trimmed)
    setSearching(false)
    if (result.ok) {
      setResults(result.value)
    } else {
      setResults([])
      setError(result.error.message)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') void runSearch()
  }

  return (
    <section className={styles.sectionFlush}>
      <div className={styles.sectionTitleRow}>
        <div>
          <p className={styles.sectionKicker}>Discover</p>
          <h2 className={styles.sectionTitle}>Find more models on Hugging Face</h2>
          <p className={styles.sectionDesc}>
            Live search across Hugging Face&apos;s GGUF catalog. Unlike the recommendations above,
            these aren&apos;t hand-vetted — quality, tool-calling support, and RAM needs are
            estimated, not verified, so check a model&apos;s own page if unsure.
          </p>
        </div>
      </div>

      <div className={styles.modelToolbar}>
        <label className={styles.searchBox}>
          <Icon name="search" size={14} />
          <input
            value={query}
            placeholder='e.g. "qwen coder", "deepseek", "phi"...'
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>
        <div className={styles.toolbarActions}>
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Icon name="search" size={14} />}
            onClick={() => void runSearch()}
            disabled={searching || !query.trim()}
          >
            {searching ? 'Searching…' : 'Search'}
          </Button>
        </div>
      </div>

      {searching && (
        <div className={styles.hardwareLoading}>
          <Spinner size={16} />
          <span>Searching Hugging Face…</span>
        </div>
      )}

      {error && <p className={styles.errorText}>{error}</p>}

      {results && results.length === 0 && !searching && !error && (
        <p className={styles.muted}>No downloadable GGUF models found for that search.</p>
      )}

      {results && results.length > 0 && !searching && (
        <div className={styles.recGrid}>
          {results.map((model) => {
            const isDownloaded = localFileNames.has(recommendedModelFileName(model).toLowerCase())
            const progress = downloads[model.id]

            return (
              <article key={model.id} className={styles.recCard}>
                <div className={styles.recCardTop}>
                  <div className={styles.recLabelGroup}>
                    <ModelDownloadIcon family={model.family} size={16} status={progress?.status} />
                    {model.hfDownloads !== undefined && (
                      <span className={styles.recLabel}>
                        {formatCount(model.hfDownloads)} downloads
                      </span>
                    )}
                  </div>
                </div>
                <h3 className={styles.recName}>{model.name}</h3>
                <p className={styles.recDescription}>{model.description}</p>
                <div className={styles.recTags}>
                  {model.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className={styles.tag}>
                      {tag}
                    </span>
                  ))}
                </div>
                <div className={styles.recSpecs}>
                  <span>{model.approxSize}</span>
                  <span className={styles.dotSep} />
                  <span>~{model.minRam} RAM (estimated)</span>
                </div>

                {isDownloaded ? (
                  <div className={styles.downloadedBadge}>
                    <Icon name="check" size={14} />
                    Downloaded
                  </div>
                ) : progress?.status === 'downloading' ? (
                  <DownloadProgress progress={progress} onCancel={() => cancelDownload(model.id)} />
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft={<Icon name="download" size={14} />}
                    onClick={() => void downloadModel(model)}
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
