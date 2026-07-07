import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Conversation } from '../../stores/chatStore'
import { formatRelativeTime } from '../../lib/time'
import { Icon } from '../Icon'
import styles from './ChatRow.module.css'

interface ChatRowProps {
  conversation: Conversation
  active: boolean
  onClick: () => void
  onDelete?: () => void
  projectName?: string
  projectPath?: string
  onRename?: (title: string) => void
  onOpenProjectFolder?: () => void
  running?: boolean
  unread?: boolean
}

/** A single chat row with title, relative last-used time, and an optional action. */
export function ChatRow({
  conversation,
  active,
  onClick,
  onDelete,
  projectName,
  projectPath,
  onRename,
  onOpenProjectFolder,
  running = false,
  unread = false
}: ChatRowProps): JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null)
  const time = formatRelativeTime(conversation.updatedAt)
  const showingStatus = running || unread

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    }
  }, [])

  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  const showDetails = (): void => {
    cancelClose()
    const rect = rowRef.current?.getBoundingClientRect()
    if (rect) setHoverRect(rect)
  }

  const hideDetails = (): void => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setHoverRect(null), 120)
  }

  return (
    <div
      ref={rowRef}
      className={`${styles.row} ${active ? styles.active : ''} ${onDelete ? styles.hasAction : ''}`}
      onMouseEnter={showDetails}
      onMouseLeave={hideDetails}
      onFocus={showDetails}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hideDetails()
      }}
    >
      <button type="button" className={styles.select} onClick={onClick} title={conversation.title}>
        <span className={styles.title}>{conversation.title}</span>
        <span className={styles.meta}>
          {showingStatus ? (
            <span
              className={`${styles.status} ${running ? styles.running : styles.unread}`}
              title={running ? 'Assistant is responding' : 'Unread'}
            >
              {running ? (
                <span className={styles.spinner} aria-hidden="true" />
              ) : (
                <span className={styles.unreadDot} aria-hidden="true" />
              )}
            </span>
          ) : (
            <span className={styles.time}>{time}</span>
          )}
        </span>
      </button>
      {onDelete && (
        <button
          type="button"
          className={styles.action}
          onClick={onDelete}
          aria-label="Delete chat"
          title="Delete chat"
        >
          <Icon name="trash" size={12} />
        </button>
      )}
      {hoverRect &&
        createPortal(
          <ChatDetailCard
            rect={hoverRect}
            title={conversation.title}
            time={time}
            projectName={projectName}
            projectPath={projectPath}
            onRename={onRename}
            onOpenProjectFolder={onOpenProjectFolder}
            running={running}
            onMouseEnter={showDetails}
            onMouseLeave={hideDetails}
          />,
          document.body
        )}
    </div>
  )
}

interface ChatDetailCardProps {
  rect: DOMRect
  title: string
  time: string
  projectName?: string
  projectPath?: string
  onRename?: (title: string) => void
  onOpenProjectFolder?: () => void
  running: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
}

function ChatDetailCard({
  rect,
  title,
  time,
  projectName,
  projectPath,
  onRename,
  onOpenProjectFolder,
  running,
  onMouseEnter,
  onMouseLeave
}: ChatDetailCardProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const top = Math.max(48, Math.min(rect.top - 10, window.innerHeight - 170))
  const left = Math.min(rect.right + 10, window.innerWidth - 340)

  const save = (): void => {
    const next = draft.trim()
    if (next && next !== title) onRename?.(next)
    setEditing(false)
  }

  return (
    <div
      className={styles.detailCard}
      style={{ top, left }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className={styles.detailHeader}>
        {editing ? (
          <input
            className={styles.renameInput}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save()
              if (event.key === 'Escape') {
                setDraft(title)
                setEditing(false)
              }
            }}
            onBlur={save}
            autoFocus
          />
        ) : (
          <button type="button" className={styles.renameButton} onClick={() => setEditing(true)}>
            <strong>{title}</strong>
            {onRename && <Icon name="pencil" size={12} />}
          </button>
        )}
        <span>{time}</span>
      </div>
      <div className={styles.detailLine}>
        <Icon name="chat" size={13} />
        <span>{projectName ?? 'General chat'}</span>
      </div>
      {projectPath && (
        <button
          type="button"
          className={`${styles.detailLine} ${styles.folderButton}`}
          onClick={onOpenProjectFolder}
          title="Open project folder"
        >
          <Icon name="folder" size={13} />
          <span>{projectPath}</span>
        </button>
      )}
      <div className={styles.detailLine}>
        <span className={`${styles.detailStatusDot} ${running ? styles.running : styles.ready}`} />
        <span>{running ? 'Assistant is responding' : 'Ready'}</span>
      </div>
    </div>
  )
}
