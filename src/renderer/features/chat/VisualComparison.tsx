import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { ExpandableImage } from '../../components/ui/ExpandableImage'
import type { VisualComparisonPair } from './visualComparisonPair'
import { useVisualPreviewImage, type ImagePreview } from './useVisualPreviewImage'
import styles from './VisualComparison.module.css'

export function VisualComparison({ pair }: { pair: VisualComparisonPair }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const label = pair.kind === 'image' ? 'Compare latest inspections' : 'Compare before and after'

  return (
    <section className={styles.wrap} aria-label="Visual comparison">
      <button
        type="button"
        className={styles.toggle}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <Icon name="layers" size={14} />
        <span>{label}</span>
        <span className={styles.path}>
          {pair.before.path === pair.after.path
            ? pair.after.path
            : `${pair.before.path} → ${pair.after.path}`}
        </span>
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={13} />
      </button>
      {expanded && pair.kind === 'image' && <ImageComparison pair={pair} />}
      {expanded && pair.kind === 'html' && <HtmlComparison pair={pair} />}
    </section>
  )
}

function ImageComparison({
  pair
}: {
  pair: Extract<VisualComparisonPair, { kind: 'image' }>
}): JSX.Element {
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

function HtmlComparison({
  pair
}: {
  pair: Extract<VisualComparisonPair, { kind: 'html' }>
}): JSX.Element {
  return (
    <div className={styles.grid}>
      <HtmlComparisonPane label="Before" preview={pair.before} />
      <HtmlComparisonPane label="After" preview={pair.after} />
    </div>
  )
}

function HtmlComparisonPane({
  label,
  preview
}: {
  label: 'Before' | 'After'
  preview: Extract<VisualComparisonPair, { kind: 'html' }>['before']
}): JSX.Element {
  return (
    <figure className={styles.pane}>
      <figcaption className={styles.paneHeader}>
        <span className={styles.label}>{label}</span>
        <span className={styles.title}>{preview.title}</span>
      </figcaption>
      <iframe
        className={styles.htmlFrame}
        srcDoc={preview.content}
        sandbox="allow-scripts"
        title={`${label}: ${preview.title}`}
      />
    </figure>
  )
}
