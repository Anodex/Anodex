import { useState } from 'react'
import { Icon } from '../../components/Icon'
import styles from './WorkspaceDockPanel.module.css'

interface WorkspaceDockPanelProps {
  title: string
  children: React.ReactNode
}

/** A collapsible section inside the Workspace Dock. */
export function WorkspaceDockPanel({ title, children }: WorkspaceDockPanelProps): JSX.Element {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className={styles.panel}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
        <span className={styles.title}>{title}</span>
      </button>
      {expanded && <div className={styles.body}>{children}</div>}
    </div>
  )
}
