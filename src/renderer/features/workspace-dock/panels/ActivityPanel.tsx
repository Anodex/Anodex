import type { ToolCall } from '@shared/tools.types'
import { Icon } from '../../../components/Icon'
import { Spinner } from '../../../components/ui/Spinner'
import { useChatStore } from '../../../stores/chatStore'
import { formatClock } from '../../../lib/format'
import { KIND_ICON, getToolCallDisplay } from '../../chat/toolCallDisplay'
import { activityOf } from '../dockActivity'
import { DockEmpty, WorkspaceDockPanel } from '../WorkspaceDockPanel'
import styles from './ActivityPanel.module.css'

/** Enough to follow a run; the transcript holds the rest. */
const SHOWN = 80

/**
 * Everything Anodex has done in this conversation, newest first: each file it
 * read or wrote, each command it ran, each page it fetched, with whether it
 * worked. The transcript says the same interleaved with prose; this is the
 * list to glance at while a long turn is running.
 */
export function ActivityPanel(): JSX.Element {
  const messages = useChatStore((s) => s.conversations.find((c) => c.id === s.activeId)?.messages)
  const activity = activityOf(messages)

  if (activity.length === 0) {
    return (
      <WorkspaceDockPanel title="Activity">
        <DockEmpty icon="activity" title="Nothing has run yet">
          Every file Anodex reads or writes, every command it runs, and every page it fetches in
          this chat is listed here as it happens.
        </DockEmpty>
      </WorkspaceDockPanel>
    )
  }

  return (
    <WorkspaceDockPanel title="Activity">
      <ol className={styles.list}>
        {activity.slice(0, SHOWN).map(({ call, at }) => (
          <ActivityRow key={call.id} call={call} at={at} />
        ))}
      </ol>
      {activity.length > SHOWN && (
        <p className={styles.more}>{activity.length - SHOWN} earlier in the conversation</p>
      )}
    </WorkspaceDockPanel>
  )
}

function ActivityRow({ call, at }: { call: ToolCall; at: number }): JSX.Element {
  const display = getToolCallDisplay(call)
  return (
    <li className={`${styles.row} ${styles[call.status]}`} title={call.title}>
      <span className={styles.status}>
        {call.status === 'running' ? <Spinner size={12} /> : <StatusIcon call={call} />}
      </span>
      <span className={styles.text}>
        <span className={styles.action}>{display.action}</span>
        {display.target && <span className={styles.target}>{display.target}</span>}
      </span>
      <span className={styles.meta}>{display.meta ?? formatClock(at)}</span>
    </li>
  )
}

function StatusIcon({ call }: { call: ToolCall }): JSX.Element {
  if (call.status === 'error') return <Icon name="alert" size={13} />
  if (call.status === 'denied') return <Icon name="close" size={13} />
  return <Icon name={KIND_ICON[call.kind]} size={13} />
}
