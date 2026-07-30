import { useEffect, useRef } from 'react'
import { matchesShortcut } from '@shared/keyboardShortcuts'
import { Icon } from '../Icon'
import styles from './SidebarSearch.module.css'

interface SidebarSearchProps {
  value: string
  onChange: (value: string) => void
  shortcut?: string
}

/** Compact search input for filtering sidebar content. */
export function SidebarSearch({ value, onChange, shortcut }: SidebarSearchProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!shortcut) return

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!matchesShortcut(event, shortcut)) return
      event.preventDefault()
      inputRef.current?.focus()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [shortcut])

  return (
    <div className={styles.search}>
      <Icon name="search" size={14} className={styles.icon} />
      <input
        ref={inputRef}
        type="text"
        className={styles.input}
        placeholder="Search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {shortcut && <kbd className={styles.shortcut}>{shortcut.replace(/\+/g, ' ')}</kbd>}
    </div>
  )
}
