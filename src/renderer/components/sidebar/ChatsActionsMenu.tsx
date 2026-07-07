import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../Icon'
import styles from './ChatsActionsMenu.module.css'

export type ChatSortMode = 'recent' | 'title'

interface ChatsActionsMenuProps {
  chatCount: number
  sortMode: ChatSortMode
  onSortModeChange: (mode: ChatSortMode) => void
  onArchiveAll: () => void
  onExpandProjects: () => void
  onCollapseProjects: () => void
}

export function ChatsActionsMenu({
  chatCount,
  sortMode,
  onSortModeChange,
  onArchiveAll,
  onExpandProjects,
  onCollapseProjects
}: ChatsActionsMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [organizeOpen, setOrganizeOpen] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)
  const [organizeRect, setOrganizeRect] = useState<DOMRect | null>(null)
  const [sortRect, setSortRect] = useState<DOMRect | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const flyoutRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      const target = event.target as Node
      const inMenu = ref.current?.contains(target) ?? false
      const inFlyout = flyoutRef.current?.contains(target) ?? false
      if (!inMenu && !inFlyout) {
        setOpen(false)
        setOrganizeOpen(false)
        setSortOpen(false)
        setOrganizeRect(null)
        setSortRect(null)
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const close = (): void => {
    setOpen(false)
    setOrganizeOpen(false)
    setSortOpen(false)
    setOrganizeRect(null)
    setSortRect(null)
  }

  const updateSortMode = (mode: ChatSortMode): void => {
    onSortModeChange(mode)
    close()
  }

  return (
    <div className={styles.menu} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => {
            const next = !value
            if (!next) {
              setOrganizeOpen(false)
              setSortOpen(false)
            }
            return next
          })
        }}
        aria-label="Chat actions"
        title="Chat actions"
      >
        <Icon name="more-vertical" size={14} />
      </button>

      {open && (
        <div className={styles.dropdown} onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className={styles.item}
            disabled={chatCount === 0}
            onClick={() => {
              close()
              onArchiveAll()
            }}
          >
            <Icon name="archive" size={14} />
            <span>Archive all chats</span>
          </button>

          <div className={styles.flyoutGroup}>
            <button
              type="button"
              className={styles.item}
              onClick={(event) => {
                setOrganizeOpen((value) => !value)
                setSortOpen(false)
                setSortRect(null)
                setOrganizeRect(event.currentTarget.getBoundingClientRect())
              }}
            >
              <Icon name="sliders" size={14} />
              <span>Organize sidebar</span>
              <Icon name="chevron-right" size={13} className={styles.chevron} />
            </button>
          </div>

          <div className={styles.flyoutGroup}>
            <button
              type="button"
              className={styles.item}
              onClick={(event) => {
                setSortOpen((value) => !value)
                setOrganizeOpen(false)
                setOrganizeRect(null)
                setSortRect(event.currentTarget.getBoundingClientRect())
              }}
            >
              <Icon name="clock" size={14} />
              <span>Sort by</span>
              <Icon name="chevron-right" size={13} className={styles.chevron} />
            </button>
          </div>
        </div>
      )}

      {organizeOpen &&
        organizeRect &&
        createPortal(
          <div
            ref={flyoutRef}
            className={styles.flyout}
            style={flyoutStyle(organizeRect)}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className={styles.item}
              onClick={() => {
                onExpandProjects()
                close()
              }}
            >
              <Icon name="chevron-down" size={14} />
              <span>Expand projects</span>
            </button>
            <button
              type="button"
              className={styles.item}
              onClick={() => {
                onCollapseProjects()
                close()
              }}
            >
              <Icon name="chevrons-up" size={14} />
              <span>Collapse projects</span>
            </button>
          </div>,
          document.body
        )}

      {sortOpen &&
        sortRect &&
        createPortal(
          <div
            ref={flyoutRef}
            className={styles.flyout}
            style={flyoutStyle(sortRect)}
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" className={styles.item} onClick={() => updateSortMode('recent')}>
              <Icon name={sortMode === 'recent' ? 'check' : 'clock'} size={14} />
              <span>Recent activity</span>
            </button>
            <button type="button" className={styles.item} onClick={() => updateSortMode('title')}>
              <Icon name={sortMode === 'title' ? 'check' : 'chat'} size={14} />
              <span>Title</span>
            </button>
          </div>,
          document.body
        )}
    </div>
  )
}

function flyoutStyle(rect: DOMRect): CSSProperties {
  const width = 190
  const left = Math.min(rect.right + 6, window.innerWidth - width - 8)
  return {
    top: rect.top,
    left,
    width
  }
}
