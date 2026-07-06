import { useState } from 'react'
import type { ToolCall } from '@shared/tools.types'
import { Icon, type IconName } from '../../components/Icon'
import { Spinner } from '../../components/ui/Spinner'
import { useSettingsStore } from '../../stores/settingsStore'
import { diffStats } from '../../lib/diffRows'
import { DiffView } from './DiffView'
import styles from './ToolCallCard.module.css'

const KIND_ICON: Record<ToolCall['kind'], IconName> = {
  read: 'folder',
  write: 'copy',
  command: 'cpu',
  web: 'web',
  plan: 'sparkle'
}

function statusIcon(call: ToolCall): IconName {
  if (call.status === 'success') return 'check'
  if (call.status === 'error') return 'alert'
  if (call.status === 'denied') return 'close'
  return KIND_ICON[call.kind]
}

/** Compact inline card representing one tool invocation in the transcript. */
export function ToolCallCard({ call }: { call: ToolCall }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const diffView = useSettingsStore((s) => s.settings?.appearance.diffView ?? 'unified')
  const hasDiff = Boolean(call.diff)

  return (
    <div className={`${styles.card} ${styles[call.status]}`}>
      <button
        type="button"
        className={styles.row}
        onClick={() => hasDiff && setExpanded((value) => !value)}
        disabled={!hasDiff}
      >
        <span className={styles.icon}>
          {call.status === 'running' ? (
            <Spinner size={14} />
          ) : (
            <Icon name={statusIcon(call)} size={14} />
          )}
        </span>
        <span className={styles.title}>{call.title}</span>
        {hasDiff && call.diff && <DiffStat before={call.diff.before} after={call.diff.after} />}
        {call.detail && <span className={styles.detail}>{call.detail}</span>}
        {hasDiff && (
          <Icon
            name={expanded ? 'chevron-down' : 'chevron-right'}
            size={13}
            className={styles.chevron}
          />
        )}
      </button>
      {expanded && call.diff && (
        <div className={styles.diffWrap}>
          <DiffView before={call.diff.before} after={call.diff.after} mode={diffView} />
        </div>
      )}
    </div>
  )
}

/** Small `+N -N` line-count summary, also reused by `ToolConfirmCard`. */
export function DiffStat({ before, after }: { before: string; after: string }): JSX.Element {
  const { added, removed } = diffStats(before, after)
  return (
    <span className={styles.diffStat}>
      <span className={styles.diffAdded}>+{added}</span>
      <span className={styles.diffRemoved}>-{removed}</span>
    </span>
  )
}
