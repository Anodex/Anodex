import type { ToolCallPreview } from '@shared/tools.types'
import { ExpandableImage } from '../../components/ui/ExpandableImage'
import { useVisualPreviewImage } from './useVisualPreviewImage'
import styles from './ChatImagePreview.module.css'

type ImagePreview = Extract<ToolCallPreview, { kind: 'image' }>

/** Exact inspected pixels, loaded live from memory or later from the durable asset store. */
export function ChatImagePreview({ preview }: { preview: ImagePreview }): JSX.Element {
  const { dataUrl, unavailable } = useVisualPreviewImage(preview)

  return (
    <figure className={styles.wrap}>
      <figcaption className={styles.header}>
        <span className={styles.title}>{preview.title}</span>
        <span className={styles.path}>{preview.path}</span>
      </figcaption>
      <div className={styles.canvas}>
        {dataUrl ? (
          <ExpandableImage
            src={dataUrl}
            alt={`${preview.source === 'assistant' ? 'Assistant image' : 'Visual inspection'} of ${
              preview.path
            }`}
            title={preview.title}
            imageClassName={styles.image}
            triggerClassName={styles.imageButton}
          />
        ) : (
          <span className={styles.notice}>
            {unavailable
              ? 'This inspected screenshot is no longer available.'
              : 'Loading screenshot…'}
          </span>
        )}
      </div>
    </figure>
  )
}
