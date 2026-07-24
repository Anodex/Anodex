import type { ToolCallPreview } from '@shared/tools.types'
import { ExpandableImage } from '../../components/ui/ExpandableImage'
import { useChatStore } from '../../stores/chatStore'
import { useVisualPreviewImage } from './useVisualPreviewImage'
import { visualRecoveryPrompt } from './visualRecoveryPrompt'
import styles from './ChatImagePreview.module.css'

type ImagePreview = Extract<ToolCallPreview, { kind: 'image' }>

/** Exact inspected pixels, loaded live from memory or later from the durable asset store. */
export function ChatImagePreview({ preview }: { preview: ImagePreview }): JSX.Element {
  const { dataUrl, unavailable, retry } = useVisualPreviewImage(preview)
  const sendMessage = useChatStore((state) => state.sendMessage)
  const recoveryLabel = preview.source === 'assistant' ? 'Show again' : 'Re-inspect'

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
          <div className={styles.notice}>
            <span>
              {unavailable ? 'This visual preview is no longer available.' : 'Loading screenshot…'}
            </span>
            {unavailable && (
              <span className={styles.recoveryActions}>
                <button
                  type="button"
                  className={styles.recoveryButton}
                  onClick={retry}
                  aria-label={`Retry ${preview.title}`}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className={styles.recoveryButton}
                  onClick={() => void sendMessage(visualRecoveryPrompt(preview))}
                  aria-label={`${recoveryLabel} ${preview.path}`}
                >
                  {recoveryLabel}
                </button>
              </span>
            )}
          </div>
        )}
      </div>
    </figure>
  )
}
