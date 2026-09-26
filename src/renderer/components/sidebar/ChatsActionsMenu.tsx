import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../Icon'
import { useAnchoredPosition } from '../../hooks/useAnchoredPosition'
import styles from './ChatsActionsMenu.module.css'

const FLYOUT_WIDTH = 190

export type ChatSortMode = 'recent' | 'title'

interface ChatsActionsMenuProps {
  chatCount: number
  sortMode: ChatSortMode
  onSortModeChange: (mode: ChatSortMode) => void
  onArchiveAll: () => void
}

export function ChatsActionsMenu({
  chatCount,
  sortMode,
  onSortModeChange,
  onArchiveAll
}: ChatsActionsMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)
  const [sortRect, setSortRect] = useState<DOMRect | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const flyoutRef = useRef<HTMLDivElement>(null)
  // Keep the sort flyout beside its row, flipping it within the window bounds.
  const flyoutStyle = useAnchoredPosition(sortOpen ? sortRect : null, flyoutRef, {
    side: 'right',
    gap: 6
  })

  useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      const target = event.target as Node
      const inMenu = ref.current?.contains(target) ?? false
      const inFlyout = flyoutRef.current?.contains(target) ?? false
      if (!inMenu && !inFlyout) {
        setOpen(false)
        setSortOpen(false)
        setSortRect(null)
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const close = (): void => {
    setOpen(false)
    setSortOpen(false)
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
                setSortOpen((value) => !value)
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

      {sortOpen &&
        sortRect &&
        createPortal(
          <div
            ref={flyoutRef}
            className={styles.flyout}
            style={{ ...flyoutStyle, width: FLYOUT_WIDTH }}
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
