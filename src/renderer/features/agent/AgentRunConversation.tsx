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
import { useLoadedConversation } from '../../hooks/useLoadedConversation'
import { formatRelativeTime } from '../../lib/time'
import { MessageContent } from '../chat/MessageContent'
import {
  STATUS_ICON,
  STATUS_LABEL,
  continueLabel,
  formatCompactTokens,
  formatDuration,
  goalHeadline,
  isLongGoal,
  planOutranResult,
  planTally,
  providerIcon,
  providerLabel,
  ranOut,
  ranOutDetail,
  runStatusLabel,
  whatChanged
} from './agentRunFormat'
import styles from './AgentRunConversation.module.css'
import { toolActionLabel, toolActionTarget } from '@shared/toolActionLabel'
import { toolsCanChangeFiles } from '@shared/tools.types'
import { CopyableId } from '../../components/CopyableId'
import { SubAgentMark } from './SubAgentMark'
import { subAgentNames } from '@shared/subAgents'
import { anodex } from '../../lib/anodex'
import type { SeriesPlace } from './runTree'

interface AgentRunConversationProps {
  run: AgentRun
  /** Sub-agents this run delegated, in the order it sent them out. */
  subAgents: AgentRun[]
  /** The run that delegated this one, when this is itself a sub-agent. */
  parentRun: AgentRun | null
  projectName: string | null
  stopping: boolean
  deciding: boolean
  onOpenRun: (runId: string) => void
  onBack: () => void
  onStop: () => void
  onRetry: () => void
  onDelete: () => void
  /** Approve the plan, as proposed or with the person's edits. */
  onApprove: (plan?: Plan) => void
  onReject: () => void
  onContinueInChat: () => void
  /** Start the next run of this work, as the list's Continue does. */
  onContinue: () => void
  /**
   * Where this run sits in ongoing work, or null when it stands alone.
   *
   * Doubles as the switch for the journal block below: `seriesPlaces` only
   * describes series with more than one run, which is exactly when the
   * journal holds something this run's own transcript does not.
   */
  seriesPlace: SeriesPlace | null
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
  // A run's turns end in a short report — "What changed: …", "Is it done: …",
  // "What would I do next: …" — and squashed onto one line with the reply above
  // it, the labels ran into each other. What changed is the line worth reading.
  const changed = whatChanged(message.content)
  if (changed) return changed
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

/**
 * A run's plan, step by step.
 *
 * A ticked step is only struck through once the run itself finished. The model
 * ticks its own steps, and a run that ticked all three and then ran out of turns
 * read as finished work above a box saying it had not finished — both true, and
 * together nonsense.
 */
function PlanList({
  plan,
  finished,
  live = false
}: {
  plan: Plan
  finished: boolean
  /** The run is working now, so its current step says so. */
  live?: boolean
}): JSX.Element {
  return (
    <ol className={styles.planSteps}>
      {plan.steps.map((step) => (
        <li
          key={step.id}
          className={`${styles.planStep} ${styles[`planStep-${step.status}`]} ${
            finished ? styles.planFinished : ''
          }`}
        >
          <span className={styles.planStepIcon}>
            {step.status === 'completed' ? (
              <Icon name="check" size={11} />
            ) : step.status === 'in_progress' && live ? (
              <Spinner size={11} />
            ) : null}
          </span>
          <span className={styles.planStepTitle}>
            {step.title}
            {live && step.status === 'in_progress' && <small>now</small>}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** The edited titles as a plan, keeping each unchanged step's id. */
function editedPlan(plan: Plan, titles: string[]): Plan {
  const unused = [...plan.steps]
  return {
    ...plan,
    updatedAt: Date.now(),
    steps: titles.map((title) => {
      const same = unused.findIndex((step) => step.title === title)
      const id = same >= 0 ? unused.splice(same, 1)[0].id : crypto.randomUUID()
      return { id, title, status: 'pending' as const }
    })
  }
}

/**
 * A plan waiting for an answer: the plan, the two answers, and what approving
 * allows. Edit turns the steps into fields; Approve sends the edited plan, and
 * the run is told the steps changed before it starts.
 *
 * Nothing else is on the page while it waits. Meters, turns and an empty state
 * reading "hasn't started yet" described a run that had not been allowed to.
 */
function PlanReview({
  run,
  deciding,
  onApprove,
  onReject
}: {
  run: AgentRun
  deciding: boolean
  onApprove: (plan?: Plan) => void
  onReject: () => void
}): JSX.Element {
  const plan = run.plan
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string[]>(() => plan?.steps.map((step) => step.title) ?? [])
  useEffect(() => {
    if (!editing) setDraft(plan?.steps.map((step) => step.title) ?? [])
  }, [plan, editing])

  const titles = draft.map((title) => title.trim()).filter(Boolean)
  const changed =
    plan !== null &&
    (titles.length !== plan.steps.length ||
      titles.some((title, index) => title !== plan.steps[index].title))
  const canApprove = plan !== null && titles.length > 0

  return (
    <section className={styles.review} aria-label="Plan waiting for approval">
      <h3 className={styles.reviewHead}>{plan ? 'Here is the plan' : 'Writing a plan…'}</h3>
      {!plan ? (
        <p className={styles.reviewNote}>Working out a plan before it acts. Check back shortly.</p>
      ) : editing ? (
        <div className={styles.planEditor}>
          {draft.map((title, index) => (
            <div key={index} className={styles.planEditRow}>
              <span className={styles.planEditNumber}>{index + 1}</span>
              <input
                className={styles.planEditInput}
                value={title}
                aria-label={`Step ${index + 1}`}
                onChange={(event) =>
                  setDraft((steps) =>
                    steps.map((step, at) => (at === index ? event.target.value : step))
                  )
                }
              />
              <button
                type="button"
                className={styles.planEditRemove}
                onClick={() => setDraft((steps) => steps.filter((_, at) => at !== index))}
                aria-label={`Remove step ${index + 1}`}
                title="Remove step"
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className={styles.planEditAdd}
            onClick={() => setDraft((steps) => [...steps, ''])}
          >
            <Icon name="plus" size={12} />
            Add a step
          </button>
        </div>
      ) : (
        <ol className={styles.reviewSteps}>
          {titles.map((title, index) => (
            <li key={index}>{title}</li>
          ))}
        </ol>
      )}
      <p className={styles.reviewNote}>
        <Icon name="shield-check" size={13} />
        {toolsCanChangeFiles(run.enabledTools)
          ? 'Until you approve it can only read and search. Approving lets it change files and run commands.'
          : 'Until you approve it can only read and search.'}
      </p>
      <div className={styles.reviewActions}>
        <Button variant="ghost" onClick={onReject} disabled={deciding || !plan}>
          Reject
        </Button>
        {plan && (
          <Button variant="secondary" onClick={() => setEditing((value) => !value)}>
            {editing ? 'Done editing' : 'Edit plan'}
          </Button>
        )}
        <Button
          variant="primary"
          onClick={() => onApprove(changed && plan ? editedPlan(plan, titles) : undefined)}
          loading={deciding}
          disabled={!canApprove}
        >
          {changed ? 'Approve changes and run' : 'Approve and run'}
        </Button>
      </div>
    </section>
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

/** Past this, a one-line goal no longer fits the two lines the title gets. */
const TITLE_CHARS = 160

/** Whether the goal holds more than its title shows: more lines, files, or length. */
function goalSaysMore(run: AgentRun): boolean {
  const headline = goalHeadline(run.goal)
  return (
    run.goal.trim() !== headline ||
    headline.length > TITLE_CHARS ||
    (run.attachments?.length ?? 0) > 0
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
                  {/* In words, as the chat and the phone say it, rather than the
                      tool's identifier in code type. */}
                  <span className={styles.toolAction}>{toolActionLabel(call)}</span>
                  <span className={styles.toolTitle}>{toolActionTarget(call)}</span>
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
/**
 * The sub-agents this run sent out, one named mark each, beside its title.
 *
 * ## The identity
 *
 * Each sub-agent gets a rosette of its own (see `SubAgentMark`) and a name of
 * its own, and carries both everywhere it appears — here, on its card in the
 * run list, and as the heading of its section in the report the parent reads
 * back. "Bravo found the null" then points at something the eye can find,
 * which a numbered list of otherwise identical rows does not.
 *
 * ## The one animation, and what its colour means
 *
 * There is a single motion: the mark turns, slowly, while that sub-agent is
 * working. It stops when the sub-agent stops, which is the bar this app holds
 * bespoke motion to — it marks something genuinely happening rather than
 * decorating a header forever.
 *
 * Colour then carries state on top of identity. A working sub-agent shows its
 * own colour; a finished one takes the colour of how it finished, so a glance
 * at a row of marks answers "are they done, and did any of them fail" without
 * reading anything. The shapes are what keep them apart once the colours have
 * converged on green — which is exactly when colour stops distinguishing them
 * and would otherwise leave three identical dots.
 */
export function SubAgentChips({
  subAgents,
  onOpenRun
}: {
  subAgents: AgentRun[]
  onOpenRun: (runId: string) => void
}): JSX.Element | null {
  if (subAgents.length === 0) return null
  // Derived from what each one was actually sent to do, falling back to
  // call-signs when that would not be useful — see `subAgentNames`.
  const names = subAgentNames(subAgents.map((child) => child.delegatedTask ?? child.goal))
  return (
    <div
      className={styles.subAgents}
      aria-label={`${subAgents.length} sub-agent${subAgents.length === 1 ? '' : 's'}`}
    >
      {subAgents.map((child, index) => (
        <button
          key={child.id}
          type="button"
          className={`${styles.subAgentChip} ${
            child.status === 'running'
              ? styles[`identity-${index % 3}`]
              : // A sub-agent that described outcomes which did not happen
                // finished 'done', and green is the wrong answer to "did any
                // of them fail" — the row of marks exists to be read at a
                // glance, and this is the case where a glance would be
                // reassured by something that should not reassure it.
                child.flaggedTurns > 0
                ? styles['status-stopped']
                : styles[`status-${child.status}`]
          }`}
          // The task, because "what is it doing" is the question these are here
          // to answer, and a tooltip answers it without spending a click.
          title={`${names[index]} — ${STATUS_LABEL[child.status]}${
            child.flaggedTurns > 0
              ? ` · ${child.flaggedTurns} turn${child.flaggedTurns === 1 ? '' : 's'} claimed an outcome that didn’t happen`
              : ''
          }
${child.delegatedTask ?? child.goal}`}
          aria-label={`Open ${names[index]}, ${STATUS_LABEL[child.status]}${
            child.flaggedTurns > 0 ? ', possible fabrication' : ''
          }`}
          onClick={() => onOpenRun(child.id)}
        >
          <SubAgentMark index={index} size={16} working={child.status === 'running'} />
          <span className={styles.subAgentName}>{names[index]}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * What the runs before this one did, read from the series journal on disk.
 *
 * The journal is the agent's memory and the argument for keeping it in plain
 * Markdown was always that the person whose agent it is can read it — but a
 * file under `userData` that you have to go and find is not really readable.
 * So the app shows it, next to the run it shaped.
 *
 * Collapsed by default. On the fifth run of a series this is the longest
 * thing on the page, and what you open a run's log for is the run.
 */
export function JournalBlock({ run }: { run: AgentRun }): JSX.Element | null {
  const [journal, setJournal] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let live = true
    // Re-read when the run finishes, not only when it changes: finishing is
    // what appends this run's own entry, and a panel still showing the
    // journal as it was at kickoff would be quietly out of date.
    void anodex.agent
      .journal(run.id)
      .then((text) => {
        if (live) setJournal(text)
      })
      .catch(() => {
        // A journal that cannot be read is not worth an error in the log
        // view; the block simply does not appear.
        if (live) setJournal(null)
      })
    return () => {
      live = false
    }
  }, [run.id, run.status])

  if (!journal) return null

  return (
    <div className={styles.journal}>
      <button
        type="button"
        className={styles.journalToggle}
        onClick={() => setOpen((shown) => !shown)}
        aria-expanded={open}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        <Icon name="clock" size={12} />
        What this work has done so far
      </button>
      {open && (
        <div className={styles.journalBody}>
          <MessageContent content={journal} />
          <p className={styles.journalNote}>
            Written by Anodex when each run finishes. The project&rsquo;s files are the record of
            what actually changed — this is the narrative beside them.
          </p>
        </div>
      )}
    </div>
  )
}

export function AgentRunConversation({
  run,
  subAgents,
  parentRun,
  projectName,
  stopping,
  deciding,
  onOpenRun,
  onBack,
  onStop,
  onRetry,
  onDelete,
  onApprove,
  onReject,
  onContinueInChat,
  onContinue,
  seriesPlace
}: AgentRunConversationProps): JSX.Element {
  const conversation = useLoadedConversation(run.conversationId)

  const turns = useMemo(
    () => (conversation?.messages ?? []).filter((message) => message.role === 'assistant'),
    [conversation?.messages]
  )

  const reviewing = run.status === 'needs-review'
  const showLivePlan = !reviewing && run.plan !== null

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.backButton}
          onClick={onBack}
          aria-label="All runs"
          title="All runs"
        >
          <Icon name="chevron-left" size={16} />
        </button>
        <div className={styles.headerText}>
          <div className={styles.titleRow}>
            <h2 className={styles.title} title={goalHeadline(run.goal)}>
              {goalHeadline(run.goal)}
            </h2>
            <SubAgentChips subAgents={subAgents} onOpenRun={onOpenRun} />
          </div>
          <p className={styles.subtitle}>
            {parentRun && (
              // A sub-agent's transcript starts mid-thought otherwise: it was
              // given one slice of somebody else's goal and never saw the rest.
              <button
                type="button"
                className={styles.parentLink}
                onClick={() => onOpenRun(parentRun.id)}
                title={parentRun.goal}
              >
                <Icon name="chevron-left" size={11} />
                part of {goalHeadline(parentRun.goal)}
              </button>
            )}
            <span className={`${styles.statusBadge} ${styles[`status-${run.status}`]}`}>
              <Icon
                name={STATUS_ICON[run.status]}
                size={12}
                className={run.status === 'running' ? styles.pulseIcon : undefined}
              />
              {runStatusLabel(run)}
            </span>
            <span className={styles.subMeta}>
              <Icon name={providerIcon(run)} size={12} />
              {providerLabel(run)}
            </span>
            {seriesPlace && (
              <span className={styles.subMeta} title="Part of one ongoing piece of work">
                <Icon name="chevrons-up" size={12} />
                run {seriesPlace.position} of {seriesPlace.total}
              </span>
            )}
            {projectName && <span className={styles.subMeta}>{projectName}</span>}
            <span>updated {formatRelativeTime(run.updatedAt)} ago</span>
            <CopyableId id={run.id} label="agent run" />
          </p>
        </div>
        <div className={styles.headerActions}>
          {run.status === 'running' && (
            <Button
              variant="secondary"
              onClick={onStop}
              disabled={stopping}
              aria-label="Stop run"
              title="Stop run"
            >
              {stopping ? <Spinner size={14} /> : <Icon name="stop" size={14} />}
            </Button>
          )}
          {/* First, and the one in colour, when the run ran out of room: going on
              is the answer the page exists to offer. */}
          {ranOut(run) && !run.parentRunId && (
            <Button variant="primary" onClick={onContinue}>
              {continueLabel(run)}
            </Button>
          )}
          {/* Not while a plan waits: Retry starts the goal again from nothing,
              beside a run that only needs an answer. */}
          {!reviewing && (
            <Button
              variant="secondary"
              onClick={onRetry}
              aria-label="Retry with these settings"
              title="Retry with these settings"
            >
              <Icon name="refresh" size={14} />
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={onDelete}
            disabled={run.status === 'running'}
            aria-label="Delete run"
            title={run.status === 'running' ? 'Stop the run before deleting it' : 'Delete run'}
          >
            <Icon name="trash" size={14} />
          </Button>
        </div>
      </div>

      <div className={styles.body}>
        {reviewing && (
          <PlanReview run={run} deciding={deciding} onApprove={onApprove} onReject={onReject} />
        )}

        {/* The goal is the title. Its own block only when it says more than
            the title can: more lines, attached files, or more than two lines
            of title. */}
        {goalSaysMore(run) && <GoalBlock run={run} />}

        {!reviewing && <BudgetBlock run={run} />}

        {run.status === 'running' && !run.limitsEnabled && run.provider !== 'local' && (
          <p className={styles.turnError + ' ' + styles.bounded}>
            <Icon name="alert" size={12} /> Unlimited run on a paid API — no automatic spend
            ceiling.
          </p>
        )}

        {!reviewing && (
          <div className={`${styles.split} ${showLivePlan ? '' : styles.splitSingle}`}>
            {showLivePlan && run.plan && (
              // Beside the turns rather than above them, so where the run is and
              // what it did are on screen together. Narrow panes stack it back.
              <aside className={styles.plan} aria-label="Plan">
                <div className={styles.planTitle}>Plan · {planTally(run.plan)}</div>
                <PlanList
                  plan={run.plan}
                  finished={run.status === 'done'}
                  live={run.status === 'running'}
                />
                {planOutranResult(run) && (
                  <p className={styles.planNote}>
                    Every step was ticked off, but the run never said it had finished. Open the last
                    turn to check, or continue it.
                  </p>
                )}
              </aside>
            )}

            <div className={styles.work}>
              {seriesPlace && <JournalBlock run={run} />}

              {ranOut(run) ? (
                // Amber, not the failure red: running out of turns is a limit
                // doing its job, and the row in the list already says so in amber.
                <p className={`${styles.turnError} ${styles.turnWarn}`}>{ranOutDetail(run)}</p>
              ) : (
                (run.status === 'error' || (run.status === 'stopped' && run.lastError)) &&
                run.lastError && (
                  <p className={styles.turnError}>
                    {run.status === 'error' ? 'Failed: ' : ''}
                    {run.lastError}
                  </p>
                )
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
                  {/* Newest first: the turn worth reading is the one that just
                      happened, and on a long run it was a scroll away. */}
                  {turns
                    .map((message, index) => ({ message, number: index + 1 }))
                    .reverse()
                    .map(({ message, number }) => (
                      <TurnView
                        key={message.id}
                        message={message}
                        number={number}
                        defaultOpen={number === turns.length}
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
          </div>
        )}
      </div>

      <div className={styles.footer}>
        <Button
          variant="secondary"
          onClick={onContinueInChat}
          disabled={!run.conversationId}
          title="Carry on from this run in a chat of your own; the run's record stays as it was"
        >
          Continue in chat
        </Button>
      </div>
    </div>
  )
}
