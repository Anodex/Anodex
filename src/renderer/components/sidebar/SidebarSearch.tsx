import { Icon } from '../Icon'
import styles from './SidebarSearch.module.css'

interface SidebarSearchProps {
  value: string
  onChange: (value: string) => void
}

/** Compact search input for filtering sidebar content. */
export function SidebarSearch({ value, onChange }: SidebarSearchProps): JSX.Element {
  return (
    <div className={styles.search}>
      <Icon name="search" size={14} className={styles.icon} />
      <input
        type="text"
        className={styles.input}
        placeholder="Search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}
