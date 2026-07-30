import styles from './ShortcutKeys.module.css'

interface ShortcutKeysProps {
  /** Normalized shortcut such as "Ctrl+Shift+L". Empty renders the disabled hint. */
  shortcut: string
  className?: string
}

/** Renders a shortcut as individual key caps rather than a raw "Ctrl+Shift+L" string. */
export function ShortcutKeys({ shortcut, className }: ShortcutKeysProps): JSX.Element {
  if (!shortcut) {
    return <span className={`${styles.disabled} ${className ?? ''}`}>Not set</span>
  }
  return (
    <span className={`${styles.keys} ${className ?? ''}`}>
      {shortcut.split('+').map((part, index) => (
        <kbd key={`${part}-${index}`} className={styles.key}>
          {displayKey(part)}
        </kbd>
      ))}
    </span>
  )
}

function displayKey(part: string): string {
  if (part === 'Escape') return 'Esc'
  if (part === 'Meta') return 'Win'
  if (part === 'ArrowUp') return '↑'
  if (part === 'ArrowDown') return '↓'
  if (part === 'ArrowLeft') return '←'
  if (part === 'ArrowRight') return '→'
  return part
}
