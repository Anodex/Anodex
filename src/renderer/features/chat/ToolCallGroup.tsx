import { useState } from 'react'
import type { ToolCall } from '@shared/tools.types'
import { Icon } from '../../components/Icon'
import { ToolCallCard } from './ToolCallCard'
import { TASK_PHASE_LABEL, type TaskPhase } from './taskPhase'
import {
  DEFAULT_TOOL_GROUP_COLLAPSE_THRESHOLD,
  shouldStartToolGroupExpanded
} from './toolGroupDisclosure'
import styles from './ToolCallGroup.module.css'

/**
 * Above this many calls in one phase run, the group collapses behind a
 * summary by default instead of rendering every card — observed directly: a
 * single turn with 35 tool calls made the transcript very long to scan, with
 * no way to see the shape of what happened without scrolling through all of
 * it. Below the threshold, turns render exactly as before (every call
 * visible), since that's the common case and collapsing it would just add a
 * click for no benefit.
 */
const COLLAPSE_THRESHOLD = DEFAULT_TOOL_GROUP_COLLAPSE_THRESHOLD

/**
 * One phase's contiguous run of tool calls (see `taskPhase.ts`). Collapsed
 * groups start collapsed only at mount — a group that's actively streaming
 * and already rendered expanded (because it started under the threshold)
 * never auto-collapses out from under the user mid-stream; it only starts
 * collapsed for an already-large group loaded from history or reached before
 * the user was watching.
 */
export function ToolCallGroup({
  phase,
  calls
}: {
  phase: TaskPhase
  calls: ToolCall[]
}): JSX.Element {
  const [expanded, setExpanded] = useState(shouldStartToolGroupExpanded(calls.length, COLLAPSE_THRESHOLD))
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
