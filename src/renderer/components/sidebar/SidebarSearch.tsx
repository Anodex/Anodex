import { useEffect, useRef } from 'react'
import { Icon } from '../Icon'
import styles from './SidebarSearch.module.css'

interface SidebarSearchProps {
  value: string
  onChange: (value: string) => void
  shortcut?: string
  focusRequested?: boolean
  onFocusRequestHandled?: () => void
}

/** Compact search input for filtering sidebar content. */
export function SidebarSearch({
  value,
  onChange,
  shortcut,
  focusRequested = false,
  onFocusRequestHandled
}: SidebarSearchProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!focusRequested) return
    inputRef.current?.focus()
    onFocusRequestHandled?.()
  }, [focusRequested, onFocusRequestHandled])

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
