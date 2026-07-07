import { useState } from 'react'
import type { MemoryEntry, MemoryKind } from '@shared/memory.types'
import { Icon } from '../../components/Icon'
import styles from './MemoryUsedCard.module.css'

const KIND_LABEL: Record<MemoryKind, string> = {
  identity: 'Identity',
  convention: 'Convention',
  gotcha: 'Gotcha',
  preference: 'Preference',
  open_task: 'Open task'
}

/**
 * Collapsed-by-default card listing which stored memories were retrieved and
 * injected into context for this turn. Without this, memory retrieval is
 * invisible — there's no way to tell whether a reply used a stored fact, or
 * why one wasn't recalled, short of inspecting the memory store directly.
 */
export function MemoryUsedCard({ entries }: { entries: MemoryEntry[] }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (entries.length === 0) return null

  return (
    <div className={styles.card}>
      <button type="button" className={styles.row} onClick={() => setExpanded((value) => !value)}>
        <span className={styles.icon}>
          <Icon name="layers" size={14} />
        </span>
        <span className={styles.title}>
          Used {entries.length} {entries.length === 1 ? 'memory' : 'memories'}
        </span>
        <Icon
          name={expanded ? 'chevron-down' : 'chevron-right'}
          size={13}
          className={styles.chevron}
        />
      </button>
      {expanded && (
        <div className={styles.list}>
          {entries.map((entry) => (
            <div key={entry.id} className={styles.item}>
              <span className={styles.badge}>{KIND_LABEL[entry.kind]}</span>
              <span className={styles.text}>{entry.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
