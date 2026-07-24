import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { ExpandableImage } from '../../components/ui/ExpandableImage'
import type { VisualComparisonPair } from './visualComparisonPair'
import { useVisualPreviewImage, type ImagePreview } from './useVisualPreviewImage'
import styles from './VisualComparison.module.css'

export function VisualComparison({ pair }: { pair: VisualComparisonPair }): JSX.Element {
  const [expanded, setExpanded] = useState(true)

  return (
    <section className={styles.wrap} aria-label="Visual comparison">
      <button
        type="button"
        className={styles.toggle}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <Icon name="layers" size={14} />
        <span>Compare latest inspections</span>
        <span className={styles.path}>{pair.after.path}</span>
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={13} />
      </button>
      {expanded && <ImageComparison pair={pair} />}
    </section>
  )
}

function ImageComparison({ pair }: { pair: VisualComparisonPair }): JSX.Element {
  const before = useVisualPreviewImage(pair.before)
  const after = useVisualPreviewImage(pair.after)

  return (
    <div className={styles.grid}>
      <ImageComparisonPane label="Before" preview={pair.before} state={before} />
      <ImageComparisonPane label="After" preview={pair.after} state={after} />
    </div>
  )
}

function ImageComparisonPane({
  label,
  preview,
  state
}: {
  label: 'Before' | 'After'
  preview: ImagePreview
  state: ReturnType<typeof useVisualPreviewImage>
}): JSX.Element {
  return (
    <figure className={styles.pane} aria-label={`${label} screenshot of ${preview.path}`}>
      <figcaption className={styles.paneHeader}>
        <span className={styles.label}>{label}</span>
        <span className={styles.title}>{preview.title}</span>
      </figcaption>
      <div className={styles.canvas}>
        {state.dataUrl ? (
          <ExpandableImage
            src={state.dataUrl}
            alt={`${label}: ${preview.path}`}
            title={`${label} — ${preview.title}`}
            imageClassName={styles.image}
            triggerClassName={styles.imageButton}
          />
        ) : (
          <span className={styles.notice}>
            {state.unavailable ? `${label} image unavailable` : `Loading ${label.toLowerCase()}…`}
          </span>
        )}
      </div>
    </figure>
  )
}
