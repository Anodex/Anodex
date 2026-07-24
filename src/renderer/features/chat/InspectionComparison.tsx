import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { ExpandableImage } from '../../components/ui/ExpandableImage'
import type { InspectionComparisonPair } from './inspectionComparisonPair'
import { useVisualPreviewImage, type ImagePreview } from './useVisualPreviewImage'
import styles from './InspectionComparison.module.css'

export function InspectionComparison({ pair }: { pair: InspectionComparisonPair }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const before = useVisualPreviewImage(pair.before, expanded)
  const after = useVisualPreviewImage(pair.after, expanded)

  return (
    <section className={styles.wrap} aria-label="Visual inspection comparison">
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
      {expanded && (
        <div className={styles.grid}>
          <ComparisonPane label="Before" preview={pair.before} state={before} />
          <ComparisonPane label="After" preview={pair.after} state={after} />
        </div>
      )}
    </section>
  )
}

function ComparisonPane({
  label,
  preview,
  state
}: {
  label: 'Before' | 'After'
  preview: ImagePreview
  state: ReturnType<typeof useVisualPreviewImage>
}): JSX.Element {
  return (
    <figure className={styles.pane}>
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
