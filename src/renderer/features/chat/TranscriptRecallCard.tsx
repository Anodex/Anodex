import { useState } from 'react'
import type { TranscriptRecallResult } from '@shared/transcriptRecall.types'
import { Icon } from '../../components/Icon'
import { useChatStore } from '../../stores/chatStore'
import { useProjectStore } from '../../stores/projectStore'
import { useUiStore } from '../../stores/uiStore'
import { formatRelativeTime } from '../../lib/time'
import styles from './TranscriptRecallCard.module.css'

/**
 * A quiet line under a reply naming the past chats it drew on, opening to the
 * excerpts. Only chats the reply actually used reach it (`recallTheReplyUsed`):
 * recall runs on every turn, and a full-width box over every reply credited
 * older chats with answers that had nothing to do with them.
 */
export function TranscriptRecallCard({
  results
}: {
  results: TranscriptRecallResult[]
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const selectConversation = useChatStore((s) => s.selectConversation)
  const setActiveProject = useProjectStore((s) => s.setActive)
  const setView = useUiStore((s) => s.setView)
  if (results.length === 0) return null

  const openConversation = (result: TranscriptRecallResult): void => {
    void setActiveProject(result.projectId)
    void selectConversation(result.conversationId)
    setView('chat')
  }

  return (
    <div className={styles.card}>
      <button
        type="button"
        className={styles.row}
        aria-expanded={expanded}
        title={expanded ? 'Hide the excerpts' : 'Show what this reply drew on'}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={styles.icon}>
          <Icon name="clock" size={12} />
        </span>
        <span className={styles.title}>
          {results.length === 1
            ? `From a past chat · ${results[0].title}`
            : `From ${results.length} past chats`}
        </span>
        <Icon
          name={expanded ? 'chevron-down' : 'chevron-right'}
          size={12}
          className={styles.chevron}
        />
      </button>
      {expanded && (
        <div className={styles.list}>
          {results.map((result) => (
            <button
              key={result.conversationId}
              type="button"
              className={styles.item}
              onClick={() => openConversation(result)}
            >
              <span className={styles.chatTitle}>{result.title}</span>
              <span className={styles.time}>{formatRelativeTime(result.updatedAt)}</span>
              {result.excerpts[0] && (
                <span className={styles.excerpt}>{result.excerpts[0].text}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
