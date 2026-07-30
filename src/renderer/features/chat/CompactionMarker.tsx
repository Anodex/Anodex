import { useState } from 'react'
import type { ConversationContextSnapshot } from '@shared/context.types'
import { Icon } from '../../components/Icon'
import { formatClock } from '../../lib/format'
import styles from './CompactionMarker.module.css'

/**
 * Full-width divider marking where older turns were folded into a context
 * snapshot — without this, compaction only fired a one-time toast, leaving
 * no lasting trace in the transcript of where it happened or what got
 * summarized away.
 *
 * A marker mounting right after its snapshot was created is the live
 * compaction moment, so it stitches itself in (thread draw + one breath of
 * light). Markers mounted from history render still.
 */
export function CompactionMarker({
  snapshot
}: {
  snapshot: ConversationContextSnapshot
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [fresh] = useState(() => Date.now() - snapshot.createdAt < 5000)

  return (
    <div className={fresh ? `${styles.wrap} ${styles.arriving}` : styles.wrap}>
      <div className={styles.dividerRow}>
        <div className={styles.line} />
        <button type="button" className={styles.pill} onClick={() => setExpanded((v) => !v)}>
          <Icon name="compact" size={12} />
          <span>
            {snapshot.removedTurns} older {snapshot.removedTurns === 1 ? 'turn' : 'turns'}{' '}
            summarized
          </span>
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={11} />
        </button>
        <div className={styles.line} />
      </div>
      {expanded && (
        <div className={styles.summary}>
          <span className={styles.summaryMeta}>{formatClock(snapshot.createdAt)}</span>
          <p className={styles.summaryText}>{snapshot.summary}</p>
        </div>
      )}
    </div>
  )
}
