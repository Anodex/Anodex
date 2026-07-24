import { formatNavigationBadgeCount } from '../../lib/navigationBadges'
import styles from './NavigationCount.module.css'

interface NavigationCountProps {
  count: number
  rail?: boolean
}

/** Compact navigation notification pill. Its parent owns the accessible label. */
export function NavigationCount({ count, rail = false }: NavigationCountProps): JSX.Element | null {
  if (count <= 0) return null

  return (
    <span className={`${styles.count} ${rail ? styles.rail : ''}`} aria-hidden="true">
      {formatNavigationBadgeCount(count)}
    </span>
  )
}
