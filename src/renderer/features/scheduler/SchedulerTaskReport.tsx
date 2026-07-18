import { useState } from 'react'
import type { ScheduledTask, TaskRunRecord } from '@shared/scheduledTask.types'
import { useChatStore } from '../../stores/chatStore'
import { Overlay } from '../../components/ui/Overlay'
import { Button } from '../../components/ui/Button'
import { Icon } from '../../components/Icon'
import { MessageContent } from '../chat/MessageContent'
import { formatRelativeTime } from '../../lib/time'
import styles from './SchedulerTaskReport.module.css'

interface SchedulerTaskReportProps {
  task: ScheduledTask
  onClose: () => void
  onOpenConversation: () => void
}

/**
 * Read-only run history for one scheduled task — what the task card's click
 * opens instead of dropping straight into the raw chat transcript, which for
 * a recurring task is just the same prompt asked over and over. Each run
 * expands to its full reply (looked up from the task's conversation by
 * `messageId`, already loaded in `chatStore` — no extra fetch needed);
 * "Open conversation" is still one click away for anyone who wants the raw
 * transcript with tool calls.
 */
export function SchedulerTaskReport({
  task,
  onClose,
  onOpenConversation
}: SchedulerTaskReportProps): JSX.Element {
  const conversation = useChatStore((s) =>
    s.conversations.find((c) => c.id === task.conversationId)
  )
  const [expandedRunId, setExpandedRunId] = useState<string | null>(task.runs[0]?.id ?? null)

  const contentFor = (run: TaskRunRecord): string | null => {
    if (!run.messageId) return null
    return conversation?.messages.find((m) => m.id === run.messageId)?.content ?? null
  }

  return (
    <Overlay onClose={onClose} ariaLabel={`${task.name} run history`} cardClassName={styles.card}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h2 className={styles.title}>{task.name}</h2>
          <p className={styles.prompt}>{task.prompt}</p>
        </div>
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className={styles.body}>
        {task.runs.length === 0 ? (
          <div className={styles.empty}>
            <Icon name="clock" size={32} className={styles.emptyIcon} />
            <p>This task hasn&apos;t run yet.</p>
          </div>
        ) : (
          <div className={styles.runList}>
            {task.runs.map((run) => {
              const expanded = expandedRunId === run.id
              const content = contentFor(run)
              return (
                <div key={run.id} className={styles.runItem}>
                  <button
                    type="button"
                    className={styles.runHeader}
                    onClick={() => setExpandedRunId(expanded ? null : run.id)}
                    aria-expanded={expanded}
                  >
                    <Icon
                      name="chevron-right"
                      size={13}
                      className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`}
                    />
                    <span className={`${styles.statusDot} ${styles[`status-${run.status}`]}`} />
                    <span className={styles.runTime}>{formatRelativeTime(run.startedAt)}</span>
                    <span className={styles.runSummary}>
                      {run.summary ?? (run.status === 'error' ? 'Failed' : 'No summary')}
                    </span>
                    {run.fabricationDetected && (
                      <span
                        className={styles.fabricationFlag}
                        title="The model described an outcome — a change, an approval, a denial — that didn't actually happen this run. Check the transcript before trusting this result."
                      >
                        <Icon name="alert" size={12} />
                      </span>
                    )}
                  </button>
                  {expanded && (
                    <div className={styles.runContent}>
                      {content ? (
                        <MessageContent content={content} />
                      ) : (
                        <p className={styles.noContent}>
                          {run.status === 'error'
                            ? (run.summary ?? 'This run failed before producing a reply.')
                            : 'No reply recorded for this run.'}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className={styles.footer}>
        <Button variant="secondary" onClick={onOpenConversation} disabled={!task.conversationId}>
          Open conversation
        </Button>
      </div>
    </Overlay>
  )
}
