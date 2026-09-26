import { useEffect, useRef, useState } from 'react'
import type { SidebarMode } from '../../stores/sidebarModeStore'
import { Icon } from '../Icon'
import styles from './SidebarModeSwitcher.module.css'

interface SidebarModeSwitcherProps {
  mode: SidebarMode
  onChange: (mode: SidebarMode) => void
}

const OPTIONS: Array<{ mode: SidebarMode; label: string; description: string }> = [
  { mode: 'chats', label: 'Chats', description: 'Conversations outside projects' },
  { mode: 'workspace', label: 'Workspace', description: 'Projects and their chats' }
]

/** Chooses which conversation collection the side panel shows. */
export function SidebarModeSwitcher({ mode, onChange }: SidebarModeSwitcherProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div className={styles.switcher} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((value) => !value)}
        aria-label={`Sidebar view: ${mode === 'chats' ? 'Chats' : 'Workspace'}`}
        aria-expanded={open}
        aria-controls="sidebar-mode-options"
      >
        <span>{mode === 'chats' ? 'Chats' : 'Workspace'}</span>
        <Icon name="chevron-down" size={13} className={open ? styles.chevronOpen : undefined} />
      </button>
      {open && (
        <div
          className={styles.menu}
          id="sidebar-mode-options"
          role="group"
          aria-label="Sidebar views"
        >
          {OPTIONS.map((option) => (
            <button
              key={option.mode}
              type="button"
              className={styles.option}
              aria-pressed={mode === option.mode}
              onClick={() => {
                onChange(option.mode)
                setOpen(false)
                triggerRef.current?.focus()
              }}
            >
              <span className={styles.optionText}>
                <span className={styles.optionLabel}>{option.label}</span>
                <span className={styles.optionDescription}>{option.description}</span>
              </span>
              {mode === option.mode && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
