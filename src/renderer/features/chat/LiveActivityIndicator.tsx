import { Spinner } from '../../components/ui/Spinner'
import styles from './MessageBubble.module.css'

/**
 * A deliberately quiet live-status treatment. It is separate from message
 * prose so a reader can tell what is still happening without mistaking it for
 * part of the assistant's answer.
 */
export function LiveActivityIndicator({ label }: { label: string }): JSX.Element {
  return (
    <span className={styles.liveActivity} role="status" aria-live="polite">
      <Spinner size={12} />
      <span className={styles.liveActivityText}>{label}</span>
    </span>
  )
}
