import { useEffect, useRef } from 'react'
import { Icon } from '../Icon'
import styles from './SidebarSearch.module.css'

interface SidebarSearchProps {
  value: string
  onChange: (value: string) => void
  shortcutHint?: string
}

/** Compact search input for filtering sidebar content. */
export function SidebarSearch({ value, onChange, shortcutHint }: SidebarSearchProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!shortcutHint) return

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      inputRef.current?.focus()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [shortcutHint])

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
      {shortcutHint && <kbd className={styles.shortcut}>{shortcutHint}</kbd>}
    </div>
  )
}
