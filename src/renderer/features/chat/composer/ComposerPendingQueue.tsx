import { useEffect, useState } from 'react'
import type { PendingMessage } from '../../../stores/chatStore'
import { Icon } from '../../../components/Icon'
import styles from '../ChatComposer.module.css'

interface ComposerPendingQueueProps {
  conversationId: string
  messages: PendingMessage[]
  onRemove: (conversationId: string, messageId: string) => void
}

/** Collapsible view of messages waiting for the current response to finish. */
export function ComposerPendingQueue({
  conversationId,
  messages,
  onRemove
}: ComposerPendingQueueProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (messages.length === 0) setExpanded(false)
  }, [messages.length])

  if (messages.length === 0) return null

  return (
    <div className={styles.pendingWrap}>
      <button
        type="button"
        className={styles.pendingSummary}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <Icon name="clock" size={12} />
        <span className={styles.pendingSummaryText}>
          {messages.length} message{messages.length === 1 ? '' : 's'} queued
        </span>
        <Icon
          name="chevron-down"
          size={12}
          className={`${styles.pendingChevron} ${expanded ? styles.pendingChevronOpen : ''}`}
        />
      </button>

      {expanded && (
        <div className={styles.pendingQueue}>
          {messages.map((message) => (
            <div key={message.id} className={styles.pendingItem}>
              <Icon name="clock" size={12} />
              <span className={styles.pendingText}>
                {message.text || `${message.attachments.length} file(s) attached`}
              </span>
              <button
                type="button"
                className={styles.pendingRemove}
                onClick={() => onRemove(conversationId, message.id)}
                aria-label="Remove queued message"
                title="Remove queued message"
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
