import { useMemo } from 'react'
import { Icon } from '../../components/Icon'
import { useModelStore } from '../../stores/modelStore'
import { summariseActiveDownloads } from './activeDownloadSummary'
import styles from './ActiveDownloads.module.css'

/**
 * Model downloads still running, shown in the Settings title bar.
 *
 * A download outlives the card that started it. The progress itself always
 * survived — `modelStore.downloads` is a store, not component state — but the
 * only things drawing it were the model cards, and the Discover panel keeps
 * its search results in `useState`. So leaving Settings and coming back
 * unmounted the one card that knew about a searched model, and a download that
 * was still running had nowhere left to appear. It looked stopped.
 *
 * Mounted by the Settings shell rather than by any page, so it holds across
 * every section for as long as something is downloading, and disappears when
 * nothing is.
 */
export function ActiveDownloads(): JSX.Element | null {
  const downloads = useModelStore((s) => s.downloads)
  const names = useModelStore((s) => s.downloadNames)

  const summary = useMemo(() => summariseActiveDownloads(downloads, names), [downloads, names])
  if (!summary) return null
  const { label, percent } = summary

  return (
    <div
      className={styles.root}
      role="status"
      aria-live="polite"
      aria-label={
        percent === null ? `${label}, downloading` : `${label}, ${percent} percent downloaded`
      }
      title={summary.names.join('\n')}
    >
      <Icon name="download" size={14} />
      <div className={styles.body}>
        <div className={styles.labelRow}>
          <span className={styles.label}>{label}</span>
          {percent !== null && <span className={styles.percent}>{percent}%</span>}
        </div>
        <div className={styles.track}>
          {/* No total means no width to honestly draw, so the bar paces
              instead of pretending to a position. */}
          <div
            className={percent === null ? styles.barIndeterminate : styles.bar}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
      </div>
    </div>
  )
}
