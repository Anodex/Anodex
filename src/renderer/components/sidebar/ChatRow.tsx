import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Conversation } from '../../stores/chatStore'
import { formatRelativeTime } from '../../lib/time'
import { notifyError } from '../../stores/uiStore'
import { Icon } from '../Icon'
import { StatusDot } from '../ui/StatusDot'
import { TextPromptDialog } from '../ui/TextPromptDialog'
import styles from './ChatRow.module.css'

interface ChatRowProps {
  conversation: Conversation
  active: boolean
  onClick: () => void
  onDelete?: () => void
  projectName?: string
  projectPath?: string
  onRename?: (title: string) => void
  onMarkUnread?: () => void
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
  onMarkUnread,
  onOpenProjectFolder,
  running = false,
  unread = false
}: ChatRowProps): JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null)
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const time = formatRelativeTime(conversation.updatedAt)

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    }
  }, [])

  useEffect(() => {
    if (!menuPoint) return

    const closeMenu = (): void => setMenuPoint(null)
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeMenu()
    }

    window.addEventListener('mousedown', closeMenu)
    window.addEventListener('contextmenu', closeMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('mousedown', closeMenu)
      window.removeEventListener('contextmenu', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuPoint])

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
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        cancelClose()
        setHoverRect(null)
        setMenuPoint({ x: event.clientX, y: event.clientY })
      }}
      onFocus={showDetails}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hideDetails()
      }}
    >
      <button type="button" className={styles.select} onClick={onClick} title={conversation.title}>
        {conversation.origin === 'scheduled' && (
          <Icon name="clock" size={12} className={styles.scheduledIcon} />
        )}
        {conversation.origin === 'agent' && (
          <Icon name="bot" size={12} className={styles.scheduledIcon} />
        )}
        <span className={styles.titleWrap}>
          <span className={styles.title}>{conversation.title}</span>
          {running && (
            <span className={styles.runTrack} aria-hidden="true">
              <span className={styles.runHalo} />
              <span className={styles.runCore} />
            </span>
          )}
        </span>
      </button>
      <span className={styles.meta}>
        <span className={styles.defaultMeta}>
          {unread ? (
            <span className={`${styles.status} ${styles.unread}`} title="Unread">
              <span className={styles.unreadDot} aria-hidden="true" />
            </span>
          ) : (
            <span className={styles.time}>{time}</span>
          )}
        </span>
        {onDelete && (
          <button
            type="button"
            className={styles.action}
            onClick={onDelete}
            aria-label="Archive chat"
            title="Archive chat"
          >
            <Icon name="archive" size={12} />
          </button>
        )}
      </span>
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
      {menuPoint &&
        createPortal(
          <ChatContextMenu
            point={menuPoint}
            conversation={conversation}
            projectPath={projectPath}
            onRename={onRename ? () => setRenaming(true) : undefined}
            onArchive={onDelete}
            onMarkUnread={onMarkUnread}
            onOpenProjectFolder={onOpenProjectFolder}
            onClose={() => setMenuPoint(null)}
          />,
          document.body
        )}
      {renaming && (
        <TextPromptDialog
          title="Rename chat"
          label="Chat name"
          initialValue={conversation.title}
          confirmLabel="Rename"
          icon="chat"
          onCancel={() => setRenaming(false)}
          onConfirm={(title) => {
            setRenaming(false)
            onRename?.(title)
          }}
        />
      )}
    </div>
  )
}

interface ChatContextMenuProps {
  point: { x: number; y: number }
  conversation: Conversation
  projectPath?: string
  onRename?: () => void
  onArchive?: () => void
  onMarkUnread?: () => void
  onOpenProjectFolder?: () => void
  onClose: () => void
}

function ChatContextMenu({
  point,
  conversation,
  projectPath,
  onRename,
  onArchive,
  onMarkUnread,
  onOpenProjectFolder,
  onClose
}: ChatContextMenuProps): JSX.Element {
  const menuWidth = 190
  const menuHeight = 290
  const left = Math.max(8, Math.min(point.x, window.innerWidth - menuWidth - 8))
  const top = Math.max(8, Math.min(point.y, window.innerHeight - menuHeight - 8))

  const run =
    (action?: () => void | Promise<void>) =>
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.stopPropagation()
      if (!action) return
      onClose()
      void action()
    }

  const copyText = async (label: string, value?: string): Promise<void> => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
    } catch (error) {
      notifyError(`Could not copy ${label}`, error instanceof Error ? error.message : undefined)
    }
  }

  return (
    <div
      className={styles.contextMenu}
      style={{ top, left }}
      role="menu"
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <MenuItem label="Pin chat" disabled />
      <MenuItem label="Rename chat" onClick={run(onRename)} disabled={!onRename} />
      <MenuItem label="Archive chat" onClick={run(onArchive)} disabled={!onArchive} />
      <MenuItem label="Mark as unread" onClick={run(onMarkUnread)} disabled={!onMarkUnread} />
      <div className={styles.contextSeparator} />
      <MenuItem
        label="Open in Explorer"
        onClick={run(onOpenProjectFolder)}
        disabled={!onOpenProjectFolder}
      />
      <MenuItem
        label="Copy working directory"
        onClick={run(() => copyText('working directory', projectPath))}
        disabled={!projectPath}
      />
      <MenuItem label="Copy chat ID" onClick={run(() => copyText('chat ID', conversation.id))} />
      <MenuItem
        label="Copy deeplink"
        onClick={run(() => copyText('deeplink', `anodex://chat/${conversation.id}`))}
      />
      <div className={styles.contextSeparator} />
      <MenuItem label="Open in new window" disabled />
    </div>
  )
}

interface MenuItemProps {
  label: string
  disabled?: boolean
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
}

function MenuItem({ label, disabled = false, onClick }: MenuItemProps): JSX.Element {
  return (
    <button
      type="button"
      className={styles.contextItem}
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
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
        <StatusDot tone={running ? 'running' : 'success'} />
        <span>{running ? 'Assistant is responding' : 'Ready'}</span>
      </div>
    </div>
  )
}
