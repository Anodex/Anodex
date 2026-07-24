import { useMemo, useState } from 'react'
import type { ChatMessage } from '@shared/chat.types'
import type { ScheduledTask, TaskRunRecord } from '@shared/scheduledTask.types'
import { describeRecurrence } from '@shared/parseWhen'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/ui/Button'
import { Spinner } from '../../components/ui/Spinner'
import { useChatStore } from '../../stores/chatStore'
import { MessageContent } from '../chat/MessageContent'
import { describeRunTiming, formatDuration, formatNextRun } from './scheduleFormat'
import { useCountdown } from './useCountdown'
import styles from './SchedulerConversation.module.css'

/** One run paired with the messages it produced, newest run first. */
interface RunSegment {
  run: TaskRunRecord
  /** Sequential number across all runs ever, not just the retained window. */
  number: number
  messages: ChatMessage[]
}

interface SchedulerConversationProps {
  task: ScheduledTask
  running: boolean
  onBack: () => void
  onRunNow: () => void
  onEdit: () => void
  onContinueInChat: () => void
}

/**
 * Splits a scheduled task's conversation into per-run segments.
 *
 * Every run appends its turns to one long-lived conversation, so a task firing
 * every 30 minutes produces ~48 indistinguishable prompt/reply pairs a day.
 * `TaskRunRecord` records the message ids each run opened and closed with, which
 * is what makes the boundaries recoverable at all — runs recorded before those
 * ids were stored fall back to just their reply.
 */
function buildSegments(task: ScheduledTask, messages: ChatMessage[]): RunSegment[] {
  const indexById = new Map(messages.map((message, index) => [message.id, index]))

  return task.runs.map((run, position) => {
    const start = run.userMessageId !== null ? indexById.get(run.userMessageId) : undefined
    const end = run.messageId !== null ? indexById.get(run.messageId) : undefined

    let slice: ChatMessage[] = []
    if (start !== undefined) {
      slice = messages.slice(start, (end ?? start) + 1)
    } else if (end !== undefined) {
      slice = [messages[end]]
    }

    return { run, number: task.runCount - position, messages: slice }
  })
}

function RunSegmentView({
  segment,
  defaultOpen
}: {
  segment: RunSegment
  defaultOpen: boolean
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const { run, messages } = segment
  const timing = describeRunTiming(run.delayedMs, run.skippedSlots)

  return (
    <div className={styles.segment}>
      <button
        type="button"
        className={styles.runHeader}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <Icon
          name="chevron-right"
          size={12}
          className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}
        />
        <span className={`${styles.statusDot} ${styles[`status-${run.status}`]}`} />
        <span className={styles.runNumber}>Run {segment.number}</span>
        <span className={styles.runTime}>
          {new Date(run.startedAt).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
          })}
        </span>
        {run.fabricationDetected && (
          <span
            className={styles.fabricationFlag}
            title="The model described an outcome — a change, an approval, a denial — that didn't actually happen this run. Check the transcript before trusting this result."
          >
            <Icon name="alert" size={12} /> unverified claim
          </span>
        )}
        {timing && <span className={styles.timingFlag}>{timing}</span>}
        <span className={styles.runMeta}>{formatDuration(run.durationMs)}</span>
      </button>

      {open && (
        <div className={styles.runBody}>
          {messages.length === 0 ? (
            <p className={styles.noContent}>
              {run.summary ?? 'No transcript was recorded for this run.'}
            </p>
          ) : (
            messages.map((message) => (
              <div key={message.id} className={styles.message} data-role={message.role}>
                {message.toolCalls && message.toolCalls.length > 0 && (
                  <div className={styles.toolCalls}>
                    {message.toolCalls.map((call) => (
                      <span
                        key={call.id}
                        className={`${styles.toolCall} ${styles[`tool-${call.status}`]}`}
                        title={call.detail ?? call.title}
                      >
                        <code>{call.name}</code>
                        <span className={styles.toolTitle}>{call.title}</span>
                      </span>
                    ))}
                  </div>
                )}
                {message.role === 'user' ? (
                  <p className={styles.promptEcho}>{message.content}</p>
                ) : (
                  <MessageContent content={message.content} />
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A scheduled task's own conversation, shown inside the Scheduler rather than
 * in the sidebar's chat list — these are a machine's run log, not a chat the
 * user held, and mixing them into CHATS buried the real conversations.
 *
 * Read-only by design: the transcript is a record of what ran unattended, so
 * it stays a trustworthy account of exactly that. "Continue in chat" forks the
 * history into a normal conversation for anyone who wants to dig into a result.
 */
export function SchedulerConversation({
  task,
  running,
  onBack,
  onRunNow,
  onEdit,
  onContinueInChat
}: SchedulerConversationProps): JSX.Element {
  const conversation = useChatStore((s) =>
    s.conversations.find((c) => c.id === task.conversationId)
  )
  useCountdown(task.enabled ? task.nextRunAt : null)

  const segments = useMemo(
    () => buildSegments(task, conversation?.messages ?? []),
    [task, conversation?.messages]
  )

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <button type="button" className={styles.backButton} onClick={onBack}>
          <Icon name="chevron-left" size={14} />
          All tasks
        </button>
        <div className={styles.headerText}>
          <h2 className={styles.title}>{task.name}</h2>
          <p className={styles.subtitle}>
            {describeRecurrence(task.recurrence)}
            {task.runCount > 0 && ` · ${task.runCount} run${task.runCount === 1 ? '' : 's'}`}
            {' · '}
            {task.enabled ? formatNextRun(task.nextRunAt).toLowerCase() : 'paused'}
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button variant="secondary" onClick={onRunNow} disabled={running}>
            {running ? <Spinner size={14} /> : <Icon name="send" size={14} />}
            Run now
          </Button>
          <Button variant="secondary" onClick={onEdit}>
            <Icon name="pencil" size={14} />
            Edit
          </Button>
        </div>
      </div>

      <div className={styles.body}>
        <p className={styles.taskPrompt}>
          <Icon name="clock" size={12} />
          {task.prompt}
        </p>

        {segments.length === 0 ? (
          <div className={styles.empty}>
            <Icon name="clock" size={32} className={styles.emptyIcon} />
            <p>This task hasn&apos;t run yet.</p>
            <p className={styles.emptyHint}>
              Its first run lands{' '}
              {task.enabled ? formatNextRun(task.nextRunAt).toLowerCase() : 'once you resume it'}.
            </p>
          </div>
        ) : (
          <div className={styles.segments}>
            {segments.map((segment, index) => (
              <RunSegmentView key={segment.run.id} segment={segment} defaultOpen={index === 0} />
            ))}
          </div>
        )}
      </div>

      <div className={styles.footer}>
        <span className={styles.footerNote}>
          A record of unattended runs — replies stay out so it keeps telling the truth.
        </span>
        <Button
          variant="secondary"
          onClick={onContinueInChat}
          disabled={!task.conversationId || segments.length === 0}
        >
          Continue in chat
        </Button>
      </div>
    </div>
  )
}
