import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent
} from 'react'
import { createPortal } from 'react-dom'
import type { Conversation } from '../../stores/chatStore'
import type { ConversationExportFormat } from '@shared/backup.types'
import { formatRelativeTime } from '../../lib/time'
import { anodex } from '../../lib/anodex'
import { notifyError, useUiStore } from '../../stores/uiStore'
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
  /**
   * Matching text from inside the conversation, shown under the title during
   * a search. Present only when the row surfaced because of what was said in
   * it — a title match needs no explanation, the reason is already visible.
   */
  excerpt?: string
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
  unread = false,
  excerpt
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
        {/*
          Autorun chats stay in the list rather than being filtered out like
          scheduled and agent runs: a harness conversation only has value if
          someone can open it and read how the assistant actually behaved, and
          until now those runs existed solely as lines in a dev log. The icon
          says at a glance that a chat was machine-driven, so a test run is not
          mistaken for the user's own.
        */}
        {conversation.origin === 'autorun' && (
          <Icon name="terminal" size={12} className={styles.scheduledIcon} />
        )}
        <span className={styles.titleWrap}>
          <span className={styles.title}>{conversation.title}</span>
          {excerpt && <span className={styles.excerpt}>{excerpt}</span>}
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
            conversationId={conversation.id}
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

/** One row of the chat context menu. A `separator` carries nothing else. */
type ChatMenuEntry =
  | { kind: 'separator'; id: string }
  | {
      kind: 'item'
      id: string
      label: string
      /**
       * Single character typed on its own to fire the row while the menu is
       * open, shown right-aligned. Menu-local, so it is not part of the
       * configurable global bindings in Settings → Keyboard.
       */
      accelerator: string
      disabled: boolean
      run?: () => void | Promise<void>
    }

/**
 * Write this chat to a file the user picks. Lives here rather than being
 * threaded down from the sidebar because the row already holds the whole
 * conversation — the only thing an export needs.
 */
async function exportChat(
  conversation: Conversation,
  format: ConversationExportFormat
): Promise<void> {
  const result = await anodex.backup.exportConversation(conversation, format)
  if (!result.ok) {
    notifyError('Could not export chat', result.error.detail ?? result.error.message)
    return
  }
  // Null means the user closed the save dialog — not a failure, and not
  // something to congratulate them about either.
  if (!result.value) return
  useUiStore.getState().notify({ kind: 'success', title: 'Chat exported', message: result.value })
}

async function copyText(label: string, value?: string): Promise<void> {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
  } catch (error) {
    notifyError(`Could not copy ${label}`, error instanceof Error ? error.message : undefined)
  }
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
  const menuRef = useRef<HTMLDivElement>(null)
  const menuWidth = 216
  const menuHeight = 300
  const left = Math.max(8, Math.min(point.x, window.innerWidth - menuWidth - 8))
  const top = Math.max(8, Math.min(point.y, window.innerHeight - menuHeight - 8))

  const entries = useMemo<ChatMenuEntry[]>(
    () => [
      { kind: 'item', id: 'pin', label: 'Pin chat', accelerator: 'P', disabled: true },
      {
        kind: 'item',
        id: 'rename',
        label: 'Rename chat',
        accelerator: 'R',
        disabled: !onRename,
        run: onRename
      },
      {
        kind: 'item',
        id: 'archive',
        label: 'Archive chat',
        accelerator: 'A',
        disabled: !onArchive,
        run: onArchive
      },
      {
        kind: 'item',
        id: 'unread',
        label: 'Mark as unread',
        accelerator: 'U',
        disabled: !onMarkUnread,
        run: onMarkUnread
      },
      { kind: 'separator', id: 'sep-1' },
      {
        kind: 'item',
        id: 'export-markdown',
        label: 'Export as Markdown',
        accelerator: 'M',
        disabled: false,
        run: () => exportChat(conversation, 'markdown')
      },
      {
        kind: 'item',
        id: 'export-json',
        label: 'Export as JSON',
        accelerator: 'J',
        disabled: false,
        run: () => exportChat(conversation, 'json')
      },
      { kind: 'separator', id: 'sep-export' },
      {
        kind: 'item',
        id: 'explorer',
        label: 'Open in Explorer',
        accelerator: 'E',
        disabled: !onOpenProjectFolder,
        run: onOpenProjectFolder
      },
      {
        kind: 'item',
        id: 'copy-cwd',
        label: 'Copy working directory',
        accelerator: 'W',
        disabled: !projectPath,
        run: () => copyText('working directory', projectPath)
      },
      {
        kind: 'item',
        id: 'copy-id',
        label: 'Copy chat ID',
        accelerator: 'I',
        disabled: false,
        run: () => copyText('chat ID', conversation.id)
      },
      {
        kind: 'item',
        id: 'copy-link',
        label: 'Copy deeplink',
        accelerator: 'L',
        disabled: false,
        run: () => copyText('deeplink', `anodex://chat/${conversation.id}`)
      },
      { kind: 'separator', id: 'sep-2' },
      {
        kind: 'item',
        id: 'new-window',
        label: 'Open in new window',
        accelerator: 'N',
        disabled: true
      }
    ],
    [conversation, onArchive, onMarkUnread, onOpenProjectFolder, onRename, projectPath]
  )

  const activate = useCallback(
    (entry: ChatMenuEntry): void => {
      if (entry.kind !== 'item' || entry.disabled || !entry.run) return
      onClose()
      void entry.run()
    },
    [onClose]
  )

  // Focus the menu itself so arrow keys work straight away — a right-click
  // leaves focus wherever it was, and nothing here is focused by default.
  useEffect(() => {
    menuRef.current?.focus()
  }, [])

  const moveFocus = (delta: number, from?: HTMLElement): void => {
    const buttons = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    ]
    if (buttons.length === 0) return
    const current = from ? buttons.indexOf(from as HTMLButtonElement) : -1
    const next = current === -1 ? (delta > 0 ? 0 : buttons.length - 1) : current + delta
    buttons[(next + buttons.length) % buttons.length]?.focus()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const active = document.activeElement
      moveFocus(
        event.key === 'ArrowDown' ? 1 : -1,
        active instanceof HTMLElement && menuRef.current?.contains(active) ? active : undefined
      )
      return
    }
    // Bare letters only: with a modifier held the user means a global binding.
    if (event.ctrlKey || event.altKey || event.metaKey || event.key.length !== 1) return
    const typed = event.key.toUpperCase()
    const match = entries.find(
      (entry) => entry.kind === 'item' && !entry.disabled && entry.accelerator === typed
    )
    if (!match) return
    event.preventDefault()
    event.stopPropagation()
    activate(match)
  }

  return (
    <div
      ref={menuRef}
      className={styles.contextMenu}
      style={{ top, left }}
      role="menu"
      tabIndex={-1}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      {entries.map((entry) =>
        entry.kind === 'separator' ? (
          <div key={entry.id} className={styles.contextSeparator} role="separator" />
        ) : (
          <MenuItem
            key={entry.id}
            label={entry.label}
            accelerator={entry.accelerator}
            disabled={entry.disabled}
            onClick={(event) => {
              event.stopPropagation()
              activate(entry)
            }}
          />
        )
      )}
    </div>
  )
}

interface MenuItemProps {
  label: string
  accelerator: string
  disabled?: boolean
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
}

function MenuItem({ label, accelerator, disabled = false, onClick }: MenuItemProps): JSX.Element {
  return (
    <button
      type="button"
      className={styles.contextItem}
      role="menuitem"
      disabled={disabled}
      aria-keyshortcuts={accelerator}
      onClick={onClick}
    >
      <span className={styles.contextLabel}>{label}</span>
      <span className={styles.contextAccelerator} aria-hidden="true">
        {accelerator}
      </span>
    </button>
  )
}

interface ChatDetailCardProps {
  rect: DOMRect
  conversationId: string
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
  conversationId,
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
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
    }
  }, [])

  const copyId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(conversationId)
      setCopied(true)
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
      // Confirmed in place rather than with a toast: the card is already under
      // the cursor, and a notification for copying a string is more
      // interruption than the act deserves.
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1400)
    } catch (error) {
      notifyError('Could not copy chat ID', error instanceof Error ? error.message : undefined)
    }
  }
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
      <button
        type="button"
        className={`${styles.detailLine} ${styles.folderButton} ${styles.idButton}`}
        onClick={() => void copyId()}
        title="Copy this chat's ID"
      >
        <Icon name={copied ? 'check' : 'copy'} size={13} />
        <span className={styles.idValue}>{copied ? 'Copied to clipboard' : conversationId}</span>
      </button>
    </div>
  )
}
