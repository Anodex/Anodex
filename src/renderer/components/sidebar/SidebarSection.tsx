import type { ReactNode } from 'react'
import { Icon, type IconName } from '../Icon'
import styles from './SidebarSection.module.css'

interface SidebarSectionProps {
  title: string
  icon?: IconName
  expanded: boolean
  onToggle: () => void
  children: ReactNode
  actions?: ReactNode
}

/** Collapsible section header with optional header actions. */
export function SidebarSection({
  title,
  icon,
  expanded,
  onToggle,
  children,
  actions
}: SidebarSectionProps): JSX.Element {
  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <button type="button" className={styles.toggle} onClick={onToggle}>
          {icon && <Icon name={icon} size={14} className={styles.sectionIcon} />}
          <span className={styles.title}>{title}</span>
          <Icon
            name="chevron-down"
            size={14}
            className={`${styles.chevron} ${expanded ? '' : styles.chevronCollapsed}`}
          />
        </button>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      {expanded && <div className={styles.content}>{children}</div>}
    </div>
  )
}
