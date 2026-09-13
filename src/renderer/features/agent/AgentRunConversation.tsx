import { useEffect, useMemo, useState } from 'react'
import { activeElapsedMs, type AgentRun } from '@shared/agentRun.types'
import type { ChatAttachment, ChatMessage } from '@shared/chat.types'
import type { Plan } from '@shared/plan.types'
import { Icon } from '../../components/Icon'
import { FileTypeIcon } from '../../components/FileTypeIcon'
import { ExpandableImage } from '../../components/ui/ExpandableImage'
import { formatBytes } from '../../lib/format'
import { loadAttachmentImage } from '../chat/loadAttachmentImage'
import { Button } from '../../components/ui/Button'
import { Spinner } from '../../components/ui/Spinner'
import { useChatStore } from '../../stores/chatStore'
import { formatRelativeTime } from '../../lib/time'
import { MessageContent } from '../chat/MessageContent'
import {
  STATUS_ICON,
  STATUS_LABEL,
  formatCompactTokens,
  formatDuration,
  goalHeadline,
  isLongGoal,
  providerIcon,
  providerLabel
} from './agentRunFormat'
import styles from './AgentRunConversation.module.css'
import { CopyableId } from '../../components/CopyableId'

interface AgentRunConversationProps {
  run: AgentRun
  projectName: string | null
  stopping: boolean
  deciding: boolean
  onBack: () => void
  onStop: () => void
  onRetry: () => void
  onDelete: () => void
  onApprove: () => void
  onReject: () => void
  onContinueInChat: () => void
}

/** Which coloured dot a turn's header carries — the run's own health, one turn deep. */
type TurnDot = 'ok' | 'warn' | 'error'

function turnDot(message: ChatMessage): TurnDot {
  if (message.error && message.errorKind !== 'bounded') return 'error'
  if (message.error) return 'warn'
  if (message.toolCalls?.some((call) => call.status === 'error' || call.status === 'denied')) {
    return 'warn'
  }
  return 'ok'
}

/** Collapsed one-liner for a turn: its reply, or a fallback when it only ran tools. */
function turnGist(message: ChatMessage): string {
  const text = message.content.replace(/\s+/g, ' ').trim()
  if (text) return text
  const count = message.toolCalls?.length ?? 0
  if (count > 0) return `${count} tool call${count === 1 ? '' : 's'}`
  return 'No output this turn'
}

/** Right-aligned turn stats: tool count, tokens, wall time — whichever are known. */
function turnMeta(message: ChatMessage): string {
  const parts: string[] = []
  const tools = message.toolCalls?.length ?? 0
  if (tools > 0) parts.push(`${tools} tool${tools === 1 ? '' : 's'}`)
  if (message.stats) {
    parts.push(formatCompactTokens(message.stats.tokens))
    parts.push(formatDuration(message.stats.durationMs))
  }
  return parts.join(' · ')
}

/** Re-renders the subtree on an interval while `active`, so a running run's
 *  elapsed-time gauge counts up instead of freezing between turn broadcasts. */
function useTick(active: boolean): void {
  const [, force] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => force((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [active])
}

function PlanList({ plan }: { plan: Plan }): JSX.Element {
  return (
    <ul className={styles.planSteps}>
      {plan.steps.map((step, index) => (
        <li key={step.id} className={`${styles.planStep} ${styles[`planStep-${step.status}`]}`}>
          <span className={styles.planStepIcon}>
            {step.status === 'completed' ? (
              <Icon name="check" size={12} />
            ) : step.status === 'in_progress' ? (
              <Spinner size={11} />
            ) : (
              <Icon name="circle" size={12} />
            )}
          </span>
          <span className={styles.planStepTitle}>
            {index + 1}. {step.title}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** One gauge in the budget block: a used/limit label over a fill meter. */
function Gauge({
  label,
  value,
  fraction
}: {
  label: string
  value: string
  fraction: number | null
}): JSX.Element {
  const clamped = fraction === null ? null : Math.min(1, Math.max(0, fraction))
  const tone =
    clamped === null ? '' : clamped >= 0.9 ? styles.danger : clamped >= 0.75 ? styles.warn : ''
  return (
    <div className={styles.gauge}>
      <div className={styles.gaugeRow}>
        <span>{label}</span>
        <b>{value}</b>
      </div>
      {clamped === null ? (
        <span className={styles.unlimited}>Unlimited</span>
      ) : (
        <div className={styles.meter}>
          <span className={`${styles.meterFill} ${tone}`} style={{ width: `${clamped * 100}%` }} />
        </div>
      )}
    </div>
  )
}

function BudgetBlock({ run }: { run: AgentRun }): JSX.Element {
  useTick(run.status === 'running')
  const limited = run.limitsEnabled
  // The same number the budget check in `AgentRunService` uses. Reading
  // `now - createdAt` here made the Time gauge climb while a run sat in
  // `needs-review` waiting to be looked at — which was honest about what the
  // budget then did, and wrong about both.
  const elapsedMs = activeElapsedMs(run)
  const maxDurationMs = run.maxDurationMinutes * 60_000

  return (
    <div className={styles.budget}>
      <Gauge
        label="Turns"
        value={limited ? `${run.turnsUsed} / ${run.maxTurns}` : `${run.turnsUsed}`}
        fraction={limited ? run.turnsUsed / run.maxTurns : null}
      />
      <Gauge
        label="Tokens"
        value={
          limited
            ? `${formatCompactTokens(run.tokensUsed)} / ${formatCompactTokens(run.maxTokens)}`
            : formatCompactTokens(run.tokensUsed)
        }
        fraction={limited ? run.tokensUsed / run.maxTokens : null}
      />
      <Gauge
        label="Time"
        value={
          limited
            ? `${formatDuration(elapsedMs)} / ${run.maxDurationMinutes}m`
            : formatDuration(elapsedMs)
        }
        fraction={limited ? elapsedMs / maxDurationMs : null}
      />
    </div>
  )
}

/** One image the run was given, read from the run's own copy. */
function GoalImage({ attachment }: { attachment: ChatAttachment }): JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const path = attachment.path
  useEffect(() => {
    let cancelled = false
    void loadAttachmentImage(path).then((result) => {
      if (cancelled) return
      setDataUrl(result)
      setMissing(result === null)
    })
    return () => {
      cancelled = true
    }
  }, [path])

  if (missing) {
    return (
      <span className={styles.goalImageMissing} title={`${attachment.name} is no longer on disk`}>
        Unavailable
      </span>
    )
  }
  if (!dataUrl) return <span className={styles.goalImageMissing}>…</span>
  return (
    <ExpandableImage
      src={dataUrl}
      alt={attachment.name}
      title={attachment.name}
      imageClassName={styles.goalImage}
    />
  )
}

/**
 * The goal as the user wrote it, with the files they gave it.
 *
 * Rendered as markdown by the same component a chat message uses, because a
 * goal is written like one: paragraphs, lists, fenced blocks. It used to be a
 * single paragraph, which collapsed every line break, so a structured
 * specification arrived as one unbroken wall of text.
 *
 * A long goal starts folded. It sits above the run's turns, and a
 * specification-length one would otherwise be all the page showed.
 */
function GoalBlock({ run }: { run: AgentRun }): JSX.Element {
  const long = isLongGoal(run.goal)
  const [expanded, setExpanded] = useState(false)
  const folded = long && !expanded
  const attachments = run.attachments ?? []
  const images = attachments.filter((attachment) => attachment.kind === 'image')
  const files = attachments.filter((attachment) => attachment.kind !== 'image')

  return (
    <section className={styles.goal} aria-label="Goal">
      <span className={styles.goalLabel}>
        <Icon name="zap" size={12} />
        Goal
      </span>
      <div className={`${styles.goalText} ${folded ? styles.goalFolded : ''}`}>
        <MessageContent content={run.goal} />
      </div>
      {long && (
        <button
          type="button"
          className={styles.goalToggle}
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
          {expanded ? 'Show less' : 'Show the full goal'}
        </button>
      )}
      {attachments.length > 0 && (
        <div className={styles.goalAttachments}>
          {images.map((attachment) => (
            <GoalImage key={attachment.path} attachment={attachment} />
          ))}
          {files.map((attachment) => (
            <span key={attachment.path} className={styles.goalFile} title={attachment.name}>
              <FileTypeIcon fileName={attachment.name} size={13} />
              <span className={styles.goalFileName}>{attachment.name}</span>
              <span className={styles.goalFileSize}>{formatBytes(attachment.sizeBytes)}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

function TurnView({
  message,
  number,
  defaultOpen
}: {
  message: ChatMessage
  number: number
  defaultOpen: boolean
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const dot = turnDot(message)
  const meta = turnMeta(message)

  return (
    <div className={styles.turn}>
      <button
        type="button"
        className={styles.turnHeader}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <Icon
          name="chevron-right"
          size={12}
          className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}
        />
        <span className={`${styles.statusDot} ${styles[`dot-${dot}`]}`} />
        <span className={styles.turnNumber}>Turn {number}</span>
        <span className={styles.turnGist}>{turnGist(message)}</span>
        {meta && <span className={styles.turnMeta}>{meta}</span>}
      </button>

      {open && (
        <div className={styles.turnBody}>
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
          {message.content.trim() ? (
            <div className={styles.turnText}>
              <MessageContent content={message.content} />
            </div>
          ) : (
            !message.toolCalls?.length && <p className={styles.noContent}>No output this turn.</p>
          )}
          {message.error && (
            <p
              className={`${styles.turnError} ${message.errorKind === 'bounded' ? styles.bounded : ''}`}
            >
              {message.error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One agent run's own log, shown inside Agent rather than ejected into the
 * sidebar's chat list — a run is a machine working unattended, and its
 * transcript is a record of exactly that, not a conversation the user held.
 *
 * Mirrors `SchedulerConversation`: read-only by design, with "Continue in
 * chat" forking the history into a normal conversation for anyone who wants to
 * pick a result back up. Where a scheduled task segments its log by run, an
 * agent run has one run and many turns, so this segments by turn — and adds
 * the live state a schedule never has: an approval gate, a plan, and budgets.
 */
export function AgentRunConversation({
  run,
  projectName,
  stopping,
  deciding,
  onBack,
  onStop,
  onRetry,
  onDelete,
  onApprove,
  onReject,
  onContinueInChat
}: AgentRunConversationProps): JSX.Element {
  const conversation = useChatStore((s) =>
    run.conversationId ? s.conversations.find((c) => c.id === run.conversationId) : undefined
  )

  const turns = useMemo(
    () => (conversation?.messages ?? []).filter((message) => message.role === 'assistant'),
    [conversation?.messages]
  )

  const reviewing = run.status === 'needs-review'
  const showLivePlan = !reviewing && run.plan !== null

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <button type="button" className={styles.backButton} onClick={onBack}>
          <Icon name="chevron-left" size={14} />
          All runs
        </button>
        <div className={styles.headerText}>
          <h2 className={styles.title} title={goalHeadline(run.goal)}>
            {goalHeadline(run.goal)}
          </h2>
          <p className={styles.subtitle}>
            <span className={`${styles.statusBadge} ${styles[`status-${run.status}`]}`}>
              <Icon
                name={STATUS_ICON[run.status]}
                size={12}
                className={run.status === 'running' ? styles.pulseIcon : undefined}
              />
              {STATUS_LABEL[run.status]}
            </span>
            <span className={styles.subMeta}>
              <Icon name={providerIcon(run)} size={12} />
              {providerLabel(run)}
            </span>
            {projectName && <span className={styles.subMeta}>{projectName}</span>}
            <span>updated {formatRelativeTime(run.updatedAt)} ago</span>
            <CopyableId id={run.id} label="agent run" />
          </p>
        </div>
        <div className={styles.headerActions}>
          {run.status === 'running' && (
            <Button variant="secondary" onClick={onStop} disabled={stopping}>
              {stopping ? <Spinner size={14} /> : <Icon name="stop" size={14} />}
              Stop
            </Button>
          )}
          <Button variant="secondary" onClick={onRetry}>
            <Icon name="refresh" size={14} />
            Retry
          </Button>
          <Button
            variant="secondary"
            onClick={onDelete}
            disabled={run.status === 'running'}
            title={run.status === 'running' ? 'Stop the run before deleting it' : 'Delete run'}
          >
            <Icon name="trash" size={14} />
          </Button>
        </div>
      </div>

      <div className={styles.body}>
        {reviewing && (
          <div className={styles.review}>
            <div className={styles.reviewHead}>
              <Icon name="eye" size={16} />
              {run.plan ? 'Plan proposed — nothing has been written yet' : 'Planning…'}
            </div>
            {run.plan ? (
              <PlanList plan={run.plan} />
            ) : (
              <p className={styles.reviewNote}>
                Working out a plan before it acts. Check back shortly.
              </p>
            )}
            <p className={styles.reviewNote}>
              Approving lets this run start acting — writing files and running commands. Until then
              it can only read and search.
            </p>
            <div className={styles.reviewActions}>
              <Button variant="secondary" onClick={onReject} disabled={deciding || !run.plan}>
                Reject
              </Button>
              <Button variant="primary" onClick={onApprove} loading={deciding} disabled={!run.plan}>
                Approve &amp; run
              </Button>
            </div>
          </div>
        )}

        <GoalBlock run={run} />

        {(run.status === 'error' || (run.status === 'stopped' && run.lastError)) &&
          run.lastError && (
            <p className={styles.turnError}>
              {run.status === 'error' ? 'Failed: ' : ''}
              {run.lastError}
            </p>
          )}

        <BudgetBlock run={run} />

        {run.status === 'running' && !run.limitsEnabled && run.provider !== 'local' && (
          <p className={styles.turnError + ' ' + styles.bounded}>
            <Icon name="alert" size={12} /> Unlimited run on a paid API — no automatic spend
            ceiling.
          </p>
        )}

        {showLivePlan && run.plan && (
          <div className={styles.plan}>
            <div className={styles.planTitle}>
              <Icon name="check" size={12} />
              Plan
            </div>
            <PlanList plan={run.plan} />
          </div>
        )}

        {turns.length === 0 ? (
          <div className={styles.empty}>
            <Icon name="bot" size={32} className={styles.emptyIcon} />
            <p>
              {run.conversationId
                ? 'This run hasn’t taken a turn yet.'
                : 'This run hasn’t started yet.'}
            </p>
          </div>
        ) : (
          <div className={styles.turns}>
            <span className={styles.sectionLabel}>
              {turns.length} turn{turns.length === 1 ? '' : 's'}
            </span>
            {turns.map((message, index) => (
              <TurnView
                key={message.id}
                message={message}
                number={index + 1}
                defaultOpen={index === turns.length - 1}
              />
            ))}
            {run.status === 'running' && (
              <div className={styles.working}>
                <Spinner size={14} />
                Still working — this updates as each turn finishes.
              </div>
            )}
          </div>
        )}
      </div>

      <div className={styles.footer}>
        <span className={styles.footerNote}>
          A record of what ran unattended — read-only, so it keeps telling the truth.
        </span>
        <Button variant="secondary" onClick={onContinueInChat} disabled={!run.conversationId}>
          Continue in chat
        </Button>
      </div>
    </div>
  )
}
