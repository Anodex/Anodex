import styles from './StatusDot.module.css'

/** Fixed vocabulary for at-a-glance state, shared across every surface that
 *  shows one instead of each inventing its own colors: `running` (pulsing,
 *  in progress), `success` (ready/completed), `warning` (needs attention but
 *  not broken), `danger` (blocked/error), `neutral` (idle/no state yet). */
export type StatusTone = 'running' | 'success' | 'warning' | 'danger' | 'neutral'

interface StatusDotProps {
  tone: StatusTone
  className?: string
}

export function StatusDot({ tone, className }: StatusDotProps): JSX.Element {
  return (
    <span className={`${styles.dot} ${styles[tone]} ${className ?? ''}`} aria-hidden="true" />
  )
}
