import { Spinner } from '../../components/ui/Spinner'
import styles from './MessageBubble.module.css'

/**
 * A deliberately quiet live-status treatment. It is separate from message
 * prose so a reader can tell what is still happening without mistaking it for
 * part of the assistant's answer.
 *
 * `progress`, a whole percent, adds a thin bar under the label — shown while the
 * model reads a long prompt, where the label alone would sit still for seconds.
 */
export function LiveActivityIndicator({
  label,
  progress
}: {
  label: string
  progress?: number
}): JSX.Element {
  return (
    <span className={styles.liveActivity} role="status" aria-live="polite">
      <Spinner size={12} />
      <span className={styles.liveActivityBody}>
        <span className={styles.liveActivityText}>{label}</span>
        {progress !== undefined && (
          <span className={styles.readingTrack} aria-hidden="true">
            <span className={styles.readingFill} style={{ width: `${progress}%` }} />
          </span>
        )}
      </span>
    </span>
  )
}
