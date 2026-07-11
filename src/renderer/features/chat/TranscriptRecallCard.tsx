import { useState } from 'react'
import type { TranscriptRecallResult } from '@shared/transcriptRecall.types'
import { Icon } from '../../components/Icon'
import { useChatStore } from '../../stores/chatStore'
import { useProjectStore } from '../../stores/projectStore'
import { useUiStore } from '../../stores/uiStore'
import { formatRelativeTime } from '../../lib/time'
import styles from './TranscriptRecallCard.module.css'

/**
 * Collapsed-by-default card listing which past conversations were retrieved
 * and injected into context for this turn — the "Past chats used"
 * counterpart to `MemoryUsedCard`. Without this, transcript recall is
 * invisible in the same way memory retrieval would be: no way to tell
 * whether (or why) a reply drew on an older conversation.
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
      <button type="button" className={styles.row} onClick={() => setExpanded((value) => !value)}>
        <span className={styles.icon}>
          <Icon name="clock" size={14} />
        </span>
        <span className={styles.title}>
          Used {results.length} past {results.length === 1 ? 'chat' : 'chats'}
        </span>
        <Icon
          name={expanded ? 'chevron-down' : 'chevron-right'}
          size={13}
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
