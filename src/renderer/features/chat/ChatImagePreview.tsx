import type { ToolCallPreview } from '@shared/tools.types'
import styles from './ChatImagePreview.module.css'

type ImagePreview = Extract<ToolCallPreview, { kind: 'image' }>

/** Ephemeral screenshot/image shown immediately beneath an inspect_visual call. */
export function ChatImagePreview({ preview }: { preview: ImagePreview }): JSX.Element {
  return (
    <figure className={styles.wrap}>
      <figcaption className={styles.header}>
        <span className={styles.title}>{preview.title}</span>
        <span className={styles.path}>{preview.path}</span>
      </figcaption>
      <div className={styles.canvas}>
        <img
          className={styles.image}
          src={preview.dataUrl}
          alt={`Visual inspection of ${preview.path}`}
        />
      </div>
    </figure>
  )
}
