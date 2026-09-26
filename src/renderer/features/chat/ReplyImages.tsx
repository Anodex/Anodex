import type { ToolCall } from '@shared/tools.types'
import { ChatImagePreview } from './ChatImagePreview'
import styles from './ReplyImages.module.css'

/** Keep inspection evidence in the work log; show only user-facing image calls. */
export function ReplyImages({ calls }: { calls: ToolCall[] }): JSX.Element | null {
  const images = calls.filter(
    (call) =>
      call.status === 'success' &&
      call.preview?.kind === 'image' &&
      ((call.name === 'show_image' && call.preview.source === 'assistant') ||
        (call.name === 'generate_image' && call.preview.source === 'generated'))
  )
  if (images.length === 0) return null

  return (
    <section className={styles.replyImages} aria-label="Images in this reply">
      <div className={styles.heading}>Images in this reply</div>
      <div className={styles.grid}>
        {images.map((call) =>
          call.preview?.kind === 'image' ? (
            <ChatImagePreview key={call.id} preview={call.preview} />
          ) : null
        )}
      </div>
    </section>
  )
}
