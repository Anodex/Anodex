import type { ReactNode } from 'react'
import { Icon, type IconName } from '../../components/Icon'
import styles from './WorkspaceDockPanel.module.css'

interface WorkspaceDockPanelProps {
  /** The panel's name, for assistive technology; the dock's header shows it on screen. */
  title: string
  children: ReactNode
}

/**
 * The body of one dock panel. The dock shows one panel at a time under a
 * header naming it, so a panel no longer carries its own collapsible title.
 */
export function WorkspaceDockPanel({ title, children }: WorkspaceDockPanelProps): JSX.Element {
  return (
    <section className={styles.panel} aria-label={title}>
      {children}
    </section>
  )
}

interface DockEmptyProps {
  icon: IconName
  title: string
  children: ReactNode
  action?: ReactNode
}

/**
 * What a panel shows before it has anything: what will appear here and what
 * puts it there, so an empty panel teaches rather than just reporting "none".
 */
export function DockEmpty({ icon, title, children, action }: DockEmptyProps): JSX.Element {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyIcon}>
        <Icon name={icon} size={20} />
      </span>
      <div className={styles.emptyTitle}>{title}</div>
      <p className={styles.emptyText}>{children}</p>
      {action && <div className={styles.emptyAction}>{action}</div>}
    </div>
  )
}
