import type { ChatMessage } from '@shared/chat.types'
import { AnodexLogo } from '../../components/AnodexLogo'
import { FileTypeIcon } from '../../components/FileTypeIcon'
import { Icon } from '../../components/Icon'
import { formatBytes, formatClock } from '../../lib/format'
import { MemoryUsedCard } from './MemoryUsedCard'
import { MessageContent } from './MessageContent'
import { ThinkingIndicator } from './ThinkingIndicator'
import { ToolCallCard } from './ToolCallCard'
import { TASK_PHASE_LABEL, buildRenderSegments, messageBlocks } from './taskPhase'
import styles from './MessageBubble.module.css'

/** A single chat turn: avatar, author/time meta, content, and optional stats. */
export function MessageBubble({ message }: { message: ChatMessage }): JSX.Element {
  const isUser = message.role === 'user'
  const segments = buildRenderSegments(messageBlocks(message))
  const showThinking = message.streaming && segments.length === 0
  const lastSegment = segments[segments.length - 1]

  return (
    <div className={`${styles.row} ${isUser ? styles.user : styles.assistant}`}>
      <div className={styles.avatar}>
        {isUser ? <span className={styles.userAvatar}>You</span> : <AnodexLogo size={28} />}
      </div>

      <div className={styles.column}>
        <div className={styles.meta}>
          <span className={styles.author}>{isUser ? 'You' : 'Anodex'}</span>
          <span className={styles.time}>{formatClock(message.createdAt)}</span>
        </div>

        <div className={styles.bubble}>
          {message.attachments && message.attachments.length > 0 && (
            <div className={styles.attachments}>
              {message.attachments.map((attachment) => (
                <span key={attachment.path} className={styles.attachment} title={attachment.path}>
                  <FileTypeIcon fileName={attachment.name} size={13} />
                  <span className={styles.attachmentName}>{attachment.name}</span>
                  <span className={styles.attachmentSize}>{formatBytes(attachment.sizeBytes)}</span>
                </span>
              ))}
            </div>
          )}
          {!isUser && message.memoryUsed && message.memoryUsed.length > 0 && (
            <div className={styles.memoryUsed}>
              <MemoryUsedCard entries={message.memoryUsed} />
            </div>
          )}
          {showThinking ? (
            <ThinkingIndicator />
          ) : (
            <div className={styles.segments}>
              {segments.map((segment, index) =>
                segment.type === 'text' ? (
                  <MessageContent key={`text-${index}`} content={segment.text} />
                ) : (
                  <div key={`tools-${index}`} className={styles.phaseGroup}>
                    <span className={styles.phaseLabel}>{TASK_PHASE_LABEL[segment.phase]}</span>
                    {segment.calls.map((call) => (
                      <ToolCallCard key={call.id} call={call} />
                    ))}
                  </div>
                )
              )}
            </div>
          )}
          {message.streaming && lastSegment?.type === 'text' && <span className={styles.caret} />}

          {message.error && (
            <div className={styles.error}>
              <Icon name="alert" size={14} />
              <span>{message.error}</span>
            </div>
          )}
        </div>

        {message.stats && !message.streaming && (
          <div className={styles.stats}>
            {message.stats.tokens} tokens · {message.stats.tokensPerSecond} tok/s
          </div>
        )}
      </div>
    </div>
  )
}
