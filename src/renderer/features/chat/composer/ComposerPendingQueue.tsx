import { useEffect, useState } from 'react'
import type { PendingMessage } from '../../../stores/chatStore'
import { Icon } from '../../../components/Icon'
import styles from '../ChatComposer.module.css'

interface ComposerPendingQueueProps {
  conversationId: string
  messages: PendingMessage[]
  onRemove: (conversationId: string, messageId: string) => void
}

/**
 * Messages waiting for the current response to finish.
 *
 * One queued message is shown as itself, with when it will go. It used to sit
 * behind a collapsed "1 message queued", so having queued something was easy
 * to miss and checking what had been queued took a click. Several still fold
 * into a summary, which says when they go as well.
 */
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

  if (messages.length === 1) {
    const [only] = messages
    return (
      <div className={styles.pendingWrap}>
        <div className={styles.pendingItem}>
          <Icon name="clock" size={12} />
          <span className={styles.pendingText}>
            <span className={styles.pendingLead}>Queued:</span>{' '}
            {only.text || `${only.attachments.length} file(s) attached`}
          </span>
          <span className={styles.pendingWhen}>sends when this reply ends</span>
          <button
            type="button"
            className={styles.pendingRemove}
            onClick={() => onRemove(conversationId, only.id)}
            aria-label="Remove queued message"
            title="Remove queued message"
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      </div>
    )
  }

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
          {messages.length} messages queued · they send in order when this reply ends
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
