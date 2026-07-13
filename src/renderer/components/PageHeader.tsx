import type { ReactNode } from 'react'
import styles from './PageHeader.module.css'

interface PageHeaderProps {
  title: string
  subtitle?: string
  /** Short context shown before the title, e.g. the active project name. */
  eyebrow?: string
  /** View-specific controls, rendered on the right. */
  actions?: ReactNode
}

/** Consistent top bar shared by every view. */
export function PageHeader({ title, subtitle, eyebrow, actions }: PageHeaderProps): JSX.Element {
  return (
    <header className={styles.header}>
      <div className={styles.titles}>
        <div className={styles.titleRow}>
          {eyebrow && (
            <>
              <span className={styles.eyebrow}>{eyebrow}</span>
              <span className={styles.eyebrowSeparator}>/</span>
            </>
          )}
          <h1 className={styles.title}>{title}</h1>
        </div>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  )
}
