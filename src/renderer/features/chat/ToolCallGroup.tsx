import { useState } from 'react'
import type { ToolCall } from '@shared/tools.types'
import { Icon } from '../../components/Icon'
import { ToolCallCard } from './ToolCallCard'
import { TASK_PHASE_LABEL, type TaskPhase } from './taskPhase'
import { shouldStartToolGroupExpanded } from './toolGroupDisclosure'
import styles from './ToolCallGroup.module.css'

/**
 * Tool groups default closed so the transcript stays compact. The phase header
 * still shows the shape of the work (action count, running/failed counts), and
 * the user can expand a phase when they want the full tool details.
 */
export function ToolCallGroup({
  phase,
  calls
}: {
  phase: TaskPhase
  calls: ToolCall[]
}): JSX.Element {
  const [expanded, setExpanded] = useState(shouldStartToolGroupExpanded(calls.length))
  const failedCount = calls.filter(
    (call) => call.status === 'error' || call.status === 'denied'
  ).length
  const runningCount = calls.filter((call) => call.status === 'running').length
  const groupMeta = [
    `${calls.length} ${calls.length === 1 ? 'action' : 'actions'}`,
    runningCount > 0 ? `${runningCount} running` : null,
    failedCount > 0 ? `${failedCount} failed` : null
  ].filter(Boolean).join(' · ')

  return (
    <section className={`${styles.group} ${expanded ? styles.expanded : styles.collapsed}`}>
      <button
        type="button"
        className={styles.labelButton}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Show'} ${TASK_PHASE_LABEL[phase]} tool calls`}
      >
        <Icon
          name={expanded ? 'chevron-down' : 'chevron-right'}
          size={12}
          className={styles.labelChevron}
        />
        <span className={styles.label}>{TASK_PHASE_LABEL[phase]}</span>
        <span className={styles.groupMeta}>{groupMeta}</span>
      </button>
      {expanded && (
        <div className={styles.callList}>
          {calls.map((call) => (
            <ToolCallCard key={call.id} call={call} />
          ))}
        </div>
      )}
    </section>
  )
}
