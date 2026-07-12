import { Icon } from '../../components/Icon'
import {
  buildContextTransparencyItems,
  type ContextTransparencyItem
} from '../../lib/contextTransparency'
import styles from './ContextTransparencyPanel.module.css'

interface ContextTransparencyPanelProps {
  projectName: string | null
  toolsEnabled: boolean
  hasProjectInstructions: boolean
  pinnedSkillNames: string[]
  attachmentCount: number
  hasContextSnapshot: boolean
}

function summaryText(items: ContextTransparencyItem[]): string {
  const project = items.find((item) => item.label === 'Project')?.value ?? 'General chat'
  const skills = items.find((item) => item.label === 'Skills')?.value
  const files = items.find((item) => item.label === 'Files')?.value
  const parts = [project]
  if (skills) parts.push(`skills: ${skills}`)
  if (files) parts.push(files)
  return parts.join(' · ')
}

/** Collapsed-by-default view of the context that will be included with the next send. */
export function ContextTransparencyPanel(props: ContextTransparencyPanelProps): JSX.Element {
  const items = buildContextTransparencyItems(props)

  return (
    <details className={styles.panel}>
      <summary className={styles.summary}>
        <span className={styles.summaryMain}>
          <Icon name="layers" size={13} />
          <span className={styles.summaryLabel}>Context</span>
          <span className={styles.summaryText}>{summaryText(items)}</span>
        </span>
        <span className={styles.summaryHint}>Details</span>
      </summary>
      <div className={styles.grid}>
        {items.map((item) => (
          <div key={item.label} className={styles.item}>
            <span className={styles.label}>{item.label}</span>
            <span className={styles.value}>{item.value}</span>
          </div>
        ))}
      </div>
    </details>
  )
}
