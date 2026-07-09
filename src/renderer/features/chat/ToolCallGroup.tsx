import { useState } from 'react'
import type { ToolCall } from '@shared/tools.types'
import { Icon } from '../../components/Icon'
import { ToolCallCard } from './ToolCallCard'
import { TASK_PHASE_LABEL, type TaskPhase } from './taskPhase'
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
const COLLAPSE_THRESHOLD = 6

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
  const [expanded, setExpanded] = useState(calls.length <= COLLAPSE_THRESHOLD)
  const collapsible = calls.length > COLLAPSE_THRESHOLD

  if (!collapsible || expanded) {
    return (
      <div className={styles.group}>
        <div className={styles.labelRow}>
          <span className={styles.label}>{TASK_PHASE_LABEL[phase]}</span>
          {collapsible && (
            <button
              type="button"
              className={styles.toggle}
              onClick={() => setExpanded(false)}
              aria-label={`Collapse ${calls.length} tool calls`}
            >
              <Icon name="chevron-down" size={12} />
              Collapse
            </button>
          )}
        </div>
        {calls.map((call) => (
          <ToolCallCard key={call.id} call={call} />
        ))}
      </div>
    )
  }

  const failedCount = calls.filter(
    (call) => call.status === 'error' || call.status === 'denied'
  ).length

  return (
    <div className={styles.group}>
      <span className={styles.label}>{TASK_PHASE_LABEL[phase]}</span>
      <button type="button" className={styles.summary} onClick={() => setExpanded(true)}>
        <Icon name="chevron-right" size={13} className={styles.summaryChevron} />
        <span className={styles.summaryText}>
          {calls.length} tool calls
          {failedCount > 0 ? ` · ${failedCount} failed` : ''}
        </span>
      </button>
    </div>
  )
}
