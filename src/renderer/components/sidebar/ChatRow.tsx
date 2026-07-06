import type { ReactNode } from 'react'
import type { Conversation } from '../../stores/chatStore'
import { formatRelativeTime } from '../../lib/time'
import styles from './ChatRow.module.css'

interface ChatRowProps {
  conversation: Conversation
  active: boolean
  onClick: () => void
  action?: ReactNode
}

/** A single chat row with title, relative last-used time, and an optional action. */
export function ChatRow({ conversation, active, onClick, action }: ChatRowProps): JSX.Element {
  return (
    <button
      type="button"
      className={`${styles.row} ${active ? styles.active : ''} ${action ? styles.hasAction : ''}`}
      onClick={onClick}
      title={conversation.title}
    >
      <span className={styles.title}>{conversation.title}</span>
      <span className={styles.meta}>
        <span className={styles.time}>{formatRelativeTime(conversation.updatedAt)}</span>
        {action && <span className={styles.action}>{action}</span>}
      </span>
    </button>
  )
}
