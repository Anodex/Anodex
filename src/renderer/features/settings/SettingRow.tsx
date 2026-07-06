import type { ReactNode } from 'react'
import styles from './SettingRow.module.css'

interface SettingRowProps {
  label: string
  description?: string
  /** The control (slider, select, etc.) shown on the right. */
  control: ReactNode
}

/** Label + description on the left, control on the right. */
export function SettingRow({ label, description, control }: SettingRowProps): JSX.Element {
  return (
    <div className={styles.row}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {description && <div className={styles.description}>{description}</div>}
      </div>
      <div className={styles.control}>{control}</div>
    </div>
  )
}
