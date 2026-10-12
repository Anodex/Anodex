import { useEffect, useRef, useState } from 'react'
import { activeElapsedMs, seriesIdOf, type AgentRun } from '@shared/agentRun.types'
import type { Plan } from '@shared/plan.types'
import { toolActionLabel, toolActionTarget } from '@shared/toolActionLabel'
import { useLoadedConversation } from '../../hooks/useLoadedConversation'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/ui/Button'
import { useArrival } from '../../components/ui/useArrival'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { useChatStore } from '../../stores/chatStore'
import { useUiStore } from '../../stores/uiStore'
import { formatRelativeTime } from '../../lib/time'
import { AgentRunEditor, type AgentRunEditorSeed } from './AgentRunEditor'
import { AgentRunConversation } from './AgentRunConversation'
import {
  continueLabel,
  formatCompactTokens,
  ranOut,
  ranOutBrief,
  runStatusLabel,
  spentLine,
  goalHeadline,
  isTerminalStatus,
  providerLabel
} from './agentRunFormat'
import { useAwayArrivals } from './useAwayArrivals'
import { describeSubAgents, groupRunsByParent, seriesPlaces, type SeriesPlace } from './runTree'
import { KeepGoingDialog } from './KeepGoingDialog'
import { SubAgentMark } from './SubAgentMark'
import { subAgentNames } from '@shared/subAgents'
import styles from './AgentView.module.css'
import { plainSummary } from '@shared/titleText'
import { runOutcomeText } from './agentRunFormat'
import { AGENT_EXAMPLES } from './agentExamples'
import { ExampleCards } from '../../components/ExampleCards'

/**
 * True for one render pass when a run reaches a terminal status the user
 * hasn't been shown yet. A run reaches a terminal status exactly once, so its
 * own id identifies the landing — unlike a scheduled task, which runs again
 * and again and has to fold in which run.
 *
 * `orchestrated` stands this down when the view is announcing a homecoming
 * itself (see `useAwayArrivals`). Passing null rather than skipping the call
 * keeps the hook order fixed while handing the moment to the parent.
 */
function useJustArrived(run: AgentRun, orchestrated: boolean): boolean {
  const eligible = !orchestrated && isTerminalStatus(run.status)
  return useArrival(eligible ? run.id : null, run.updatedAt)
}

/** Fraction of a budget past which it's worth warning rather than just reporting. */
const BUDGET_WARN_AT = 0.8

/**
 * Re-renders a running card every half minute so its elapsed-time budget keeps
 * up. Without it the time meter only advances when a turn completes, which on a
 * slow local model means a bar that sits still for minutes while the budget it
 * describes is genuinely draining.
 */
function useElapsedTick(active: boolean): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setTick((value) => value + 1), 30_000)
    return () => clearInterval(timer)
  }, [active])
}

/**
 * A run's budgets as three hairlines instead of thirty-odd characters of
 * accounting inside the status pill. "Nearly out of turns" becomes a glance
 * rather than a subtraction, and the token bar tints toward `--warn` as it
 * approaches a ceiling that costs real money.
 *
 * An unlimited run gets no fill at all — there is no ceiling to draw against,
 * so it shows the raw counts over a dashed rule. You can't fill something with
 * no end, and pretending otherwise would be the one dishonest thing this could
 * do.
 */
function BudgetMeters({ run }: { run: AgentRun }): JSX.Element {
  useElapsedTick(run.status === 'running')
  // The same reading `AgentRunService` stops the run on, and the same one
  // `AgentRunConversation`'s Time gauge shows. Round four §2 moved the duration
  // budget onto time actually spent working and updated the gauge; this second
  // consumer was missed, so the card went on measuring `now - createdAt` — it
  // climbed while a run sat unapproved in `needs-review`, and disagreed with
  // both the budget and the other view of the same run.
  const elapsedMinutes = activeElapsedMs(run) / 60_000

  const meters = run.limitsEnabled
    ? [
        {
          label: 'Turns',
          text: `${run.turnsUsed}/${run.maxTurns}`,
          fraction: run.turnsUsed / run.maxTurns
        },
        {
          label: 'Tokens',
          text: `${formatCompactTokens(run.tokensUsed)}/${formatCompactTokens(run.maxTokens)}`,
          fraction: run.tokensUsed / run.maxTokens
        },
        {
          label: 'Time',
          text: `${Math.floor(elapsedMinutes)}/${run.maxDurationMinutes} min`,
          fraction: elapsedMinutes / run.maxDurationMinutes
        }
      ]
    : [
        { label: 'Turns', text: String(run.turnsUsed), fraction: null },
        { label: 'Tokens', text: formatCompactTokens(run.tokensUsed), fraction: null },
        { label: 'Time', text: `${Math.floor(elapsedMinutes)} min`, fraction: null }
      ]

  return (
    <div className={styles.meters}>
      {meters.map((meter) => {
        const clamped = meter.fraction === null ? null : Math.min(1, Math.max(0, meter.fraction))
        const warn = clamped !== null && clamped >= BUDGET_WARN_AT
        return (
          <div key={meter.label} className={`${styles.meter} ${warn ? styles.meterWarn : ''}`}>
            <span className={styles.meterHead}>
              <span>{meter.label}</span>
              <b>{meter.text}</b>
            </span>
            {clamped === null ? (
              <span className={styles.openEndedRule} aria-hidden="true" />
            ) : (
              <span className={styles.meterTrack} aria-hidden="true">
                <span className={styles.meterFill} style={{ width: `${clamped * 100}%` }} />
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * States the homecoming in words: several runs finished unattended and you've
 * just come back to find them.
 *
 * Stays until dismissed or acted on, unlike the beam that announces it. Motion
 * is bounded because it's a performance; this is a fact about the list, and
 * facts don't expire on a timer.
 */
function AwayBand({
  runs,
  filtered,
  onShow,
  onClearFilter,
  onDismiss
}: {
  runs: AgentRun[]
  filtered: boolean
  onShow: () => void
  onClearFilter: () => void
  onDismiss: () => void
}): JSX.Element {
  const counts = { done: 0, stopped: 0, error: 0, 'needs-review': 0, running: 0 }
  runs.forEach((run) => (counts[run.status] += 1))
  const parts = [
    counts.done > 0 ? `${counts.done} done` : null,
    counts['needs-review'] > 0 ? `${counts['needs-review']} needs review` : null,
    counts.stopped > 0 ? `${counts.stopped} stopped` : null,
    counts.error > 0 ? `${counts.error} failed` : null
  ].filter(Boolean)
  const newest = runs.reduce((latest, run) => Math.max(latest, run.updatedAt), 0)

  return (
    <section className={styles.awayBand} aria-label="Runs that finished while you were away">
      <span className={styles.awayIcon}>
        <Icon name="bot" size={15} />
      </span>
      <span className={styles.awayText}>
        <span className={styles.awayTitle}>{runs.length} runs finished while you were away</span>
        <span className={styles.awayDetail}>
          {parts.join(' · ')} — the last one landed {formatRelativeTime(newest)}
        </span>
      </span>
      <button
        type="button"
        className={styles.awayAction}
        onClick={filtered ? onClearFilter : onShow}
      >
        {filtered ? 'Show all runs' : 'Show only these'}
      </button>
      <button type="button" className={styles.awayDismiss} onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  )
}

/** Which part of the list a run belongs in: what needs you, what is working, what is done. */
type Section = 'needs-you' | 'working' | 'finished'

const SECTION_ORDER: Section[] = ['needs-you', 'working', 'finished']
const SECTION_LABEL: Record<Section, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  finished: 'Finished'
}

/**
 * A run waiting on a person comes first: a plan to approve, or a run that ran
 * out of room and is one click from carrying on. Sorted by age alone, a plan
 * waiting for approval sat below runs that needed nothing from anyone.
 */
function sectionOf(run: AgentRun): Section {
  if (run.status === 'running') return 'working'
  if (run.status === 'needs-review' || (ranOut(run) && !run.parentRunId)) return 'needs-you'
  return 'finished'
}

type DotTone = 'run' | 'wait' | 'ok' | 'stopped' | 'bad'

function dotTone(run: AgentRun): DotTone {
  if (run.status === 'running') return 'run'
  if (run.status === 'needs-review' || ranOut(run)) return 'wait'
  if (run.status === 'error') return 'bad'
  // A run that claimed outcomes which never happened is not a clean green.
  if (run.status === 'done') return run.flaggedTurns > 0 ? 'wait' : 'ok'
  return 'stopped'
}

/** The plan step being worked on, or the next one, with its 1-based number. */
function currentStep(run: AgentRun): { title: string; number: number; total: number } | null {
  const steps = run.plan?.steps ?? []
  const index = steps.findIndex((step) => step.status === 'in_progress')
  const at = index >= 0 ? index : steps.findIndex((step) => step.status === 'pending')
  if (at < 0) return null
  return { title: steps[at].title, number: at + 1, total: steps.length }
}

/** The one line under a run's goal: what it is doing, waiting for, or ended with. */
function runSubline(run: AgentRun): string {
  if (run.status === 'needs-review') {
    if (!run.plan) return 'Writing a plan before it acts'
    const steps = run.plan.steps.length
    return `Plan ready · ${steps} step${steps === 1 ? '' : 's'} · nothing changed yet`
  }
  if (run.status === 'running') {
    const step = currentStep(run)
    const turn = Math.min(run.turnsUsed + 1, run.limitsEnabled ? run.maxTurns : Infinity)
    const turnText = run.limitsEnabled ? `turn ${turn} of ${run.maxTurns}` : `turn ${turn}`
    return step
      ? `${step.title} · step ${step.number} of ${step.total} · ${turnText}`
      : `Working · ${turnText}`
  }
  return ranOutBrief(run) ?? (plainSummary(runOutcomeText(run)) || runStatusLabel(run))
}

/**
 * What a running run did last, in the words the chat uses: "Edited
 * src/settings/theme.ts". Read from its conversation, which the chat store keeps
 * current as each turn lands.
 */
function useLastAction(run: AgentRun): string | null {
  const conversation = useLoadedConversation(run.status === 'running' ? run.conversationId : null)
  const messages = conversation?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index--) {
    const call = messages[index].toolCalls?.at(-1)
    if (call) return `${toolActionLabel(call)} ${toolActionTarget(call)}`.trim()
  }
  return null
}

/**
 * How far through its plan a running run is, as a ring that fills step by step.
 * A run with no plan yet gets a turning arc instead: working, with no fraction
 * to claim.
 */
function PlanRing({ run }: { run: AgentRun }): JSX.Element {
  const steps = run.plan?.steps ?? []
  const done = steps.filter((step) => step.status === 'completed').length
  const radius = 19
  const length = 2 * Math.PI * radius
  const known = steps.length > 0
  const fraction = known ? done / steps.length : 0.28
  return (
    <svg
      className={`${styles.ring} ${known ? '' : styles.ringSpin}`}
      viewBox="0 0 46 46"
      role="img"
      aria-label={known ? `${done} of ${steps.length} steps done` : 'Working'}
    >
      <defs>
        <linearGradient id={`ring-${run.id}`} x1="0" x2="1">
          <stop offset="0" stopColor="var(--accent-violet)" />
          <stop offset="1" stopColor="var(--accent)" />
        </linearGradient>
      </defs>
      <circle className={styles.ringTrack} cx="23" cy="23" r={radius} />
      <circle
        className={styles.ringFill}
        cx="23"
        cy="23"
        r={radius}
        stroke={`url(#ring-${run.id})`}
        strokeDasharray={`${Math.max(0.001, fraction) * length} ${length}`}
        transform="rotate(-90 23 23)"
      />
      {known && (
        <text x="23" y="27" textAnchor="middle" className={styles.ringText}>
          {done}/{steps.length}
        </text>
      )}
    </svg>
  )
}

function RunCard({
  run,
  stoppingId,
  projectName,
  openRun,
  handleStop,
  retryRun,
  continueRun,
  keepGoing,
  deleteRun,
  subAgents = [],
  subAgentIndex = null,
  subAgentLabel = null,
  seriesPlace = null,
  orchestrated = false,
  spotlit = false,
  cardRef
}: {
  run: AgentRun
  /** Sub-agents this run delegated, rendered as their own rows beneath it. */
  subAgents?: AgentRun[]
  /** Where this run sits among its parent's sub-agents — decides its mark. */
  subAgentIndex?: number | null
  /** What its parent calls it, resolved across the whole delegation. */
  subAgentLabel?: string | null
  /** Where this run sits in ongoing work, when it continues any. */
  seriesPlace?: SeriesPlace | null
  stoppingId: string | null
  projectName: (projectId: string | null) => string | null
  openRun: (run: AgentRun) => void
  handleStop: (run: AgentRun) => void
  retryRun: (run: AgentRun) => void
  /** Start the next run of this ongoing work, carrying its series. */
  continueRun: (run: AgentRun) => void
  keepGoing: (run: AgentRun) => void
  deleteRun: (run: AgentRun) => void
  /** The view is announcing this landing itself; don't self-announce. */
  orchestrated?: boolean
  /** The homecoming beam is resting on this run right now. */
  spotlit?: boolean
  cardRef?: (element: HTMLDivElement | null) => void
}): JSX.Element {
  const justArrived = useJustArrived(run, orchestrated)
  const arrived = orchestrated ? spotlit : justArrived
  // A sub-agent stays a row even while it works: the live card is for the run
  // the person started, and three of them stacked would bury it.
  const live = run.status === 'running' && subAgentIndex === null
  const lastAction = useLastAction(run)
  const tone = dotTone(run)
  const project = projectName(run.projectId)
  const subAgentText = describeSubAgents(subAgents)

  return (
    <div
      ref={cardRef}
      className={`${styles.run} ${live ? styles.live : styles.row} ${
        styles[`run-${run.status}`] ?? ''
      } ${arrived ? styles.arrived : ''}`}
    >
      <button type="button" className={styles.runMain} onClick={() => openRun(run)}>
        {live ? (
          <PlanRing run={run} />
        ) : (
          <span
            className={`${styles.dot} ${styles[`dot-${tone}`]} ${
              run.status === 'needs-review' ? styles.dotWaiting : ''
            }`}
            title={`${runStatusLabel(run)} · ${providerLabel(run)}`}
          />
        )}
        <span className={styles.runText}>
          <span className={styles.runGoal}>
            {run.parentRunId && subAgentIndex !== null && (
              // The same mark and name this run carries beside its parent's
              // title and at the head of its section in the report — one
              // identity in three places rather than three coincidences.
              <span className={styles.subRunTag} title="Delegated by another run">
                <SubAgentMark
                  index={subAgentIndex}
                  size={13}
                  working={run.status === 'running'}
                  className={styles[`identity-${subAgentIndex % 3}`]}
                />
                {subAgentLabel}
              </span>
            )}
            {goalHeadline(run.goal)}
          </span>
          <span className={`${styles.runSub} ${run.status === 'error' ? styles.runSubError : ''}`}>
            {runSubline(run)}
          </span>
          {live && lastAction && <span className={styles.lastAction}>{lastAction}</span>}
          {live && <BudgetMeters run={run} />}
          <span className={styles.srOnly}>{runStatusLabel(run)}</span>
        </span>
      </button>

      <span className={styles.runTags}>
        {project && <span className={styles.runProject}>{project}</span>}
        {seriesPlace && (
          // Only on work that actually carried over — see `seriesPlaces`.
          // Without it a continuation is indistinguishable from a run that
          // happens to repeat the same goal.
          <span className={styles.seriesMark} title="Part of one ongoing piece of work">
            <Icon name="chevrons-up" size={12} />
            {seriesPlace.position} of {seriesPlace.total}
          </span>
        )}
        {subAgentText && (
          <span className={styles.subAgentCount} title={subAgentText}>
            <Icon name="bot" size={12} />
            {subAgents.length}
          </span>
        )}
        {run.status === 'running' && !run.limitsEnabled && run.provider !== 'local' && (
          <span
            className={styles.unlimitedWarning}
            title="Unlimited run on a paid API — no automatic spend ceiling."
          >
            <Icon name="alert" size={12} />
            Unlimited spend
          </span>
        )}
        {run.flaggedTurns > 0 && (
          <span
            className={styles.unlimitedWarning}
            title={`The model described an outcome — a change, an approval, a denial — that didn't actually happen on ${run.flaggedTurns} turn${run.flaggedTurns === 1 ? '' : 's'}. Check the transcript before trusting this result.`}
          >
            <Icon name="alert" size={12} />
            Possible fabrication ({run.flaggedTurns})
          </span>
        )}
      </span>

      {run.status === 'needs-review' && run.plan && (
        <Button variant="primary" size="sm" onClick={() => openRun(run)}>
          Review plan
        </Button>
      )}
      {/* A run that ran out of room gets the way on, on its row, rather than
          behind a hover-only icon. The phone's card does the same. Not for a
          sub-agent: its parent decides whether it goes on. */}
      {ranOut(run) && !run.parentRunId && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => continueRun(run)}
          title={spentLine(run)}
        >
          {continueLabel(run)}
        </Button>
      )}

      <span className={styles.runWhen}>{formatRelativeTime(run.updatedAt)}</span>

      <div className={styles.runActions}>
        {run.status === 'running' && (
          <button
            type="button"
            className={styles.iconAction}
            onClick={() => void handleStop(run)}
            disabled={stoppingId === run.id}
            aria-label="Stop run"
            title="Stop run"
          >
            <Icon name="stop" size={14} />
          </button>
        )}
        {/* Continue, not Retry. Retry starts the same goal over from nothing;
            this starts the next run of an ongoing piece of work, which reads
            what the runs before it did. Only once a run has finished, because
            continuing something still in flight would have two runs acting on
            one series at once. */}
        {isTerminalStatus(run.status) && !run.parentRunId && !ranOut(run) && (
          <button
            type="button"
            className={styles.iconAction}
            onClick={() => continueRun(run)}
            aria-label="Continue this work in a new run"
            title="Continue this work in a new run"
          >
            <Icon name="chevrons-up" size={14} />
          </button>
        )}
        {/* The same decision as Continue, made once instead of every time. */}
        {isTerminalStatus(run.status) && !run.parentRunId && (
          <button
            type="button"
            className={styles.iconAction}
            onClick={() => keepGoing(run)}
            aria-label="Keep this work going on a schedule"
            title="Keep this work going on a schedule"
          >
            <Icon name="clock" size={14} />
          </button>
        )}
        {/* Not while a plan waits: Retry would start the same goal again from
            nothing, beside the run that is only waiting for an answer. */}
        {run.status !== 'needs-review' && (
          <button
            type="button"
            className={styles.iconAction}
            onClick={() => retryRun(run)}
            aria-label="Retry with these settings"
            title="Retry with these settings"
          >
            <Icon name="refresh" size={14} />
          </button>
        )}
        <button
          type="button"
          className={styles.iconAction}
          onClick={() => deleteRun(run)}
          disabled={run.status === 'running'}
          aria-label="Delete run"
          title={run.status === 'running' ? 'Stop the run before deleting it' : 'Delete run'}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  )
}

/**
 * Dedicated main view for autonomous agent runs — replaces the chat pane the
 * same way `SchedulerView` does (inline, not a popup or separate window).
 *
 * Clicking a run drills into its own log *inside Agent* rather than ejecting
 * into the sidebar's chat list: a run is a machine working unattended, and its
 * transcript belongs where its controls and history already are.
 */
export function AgentView(): JSX.Element {
  const runs = useAgentStore((s) => s.runs)
  const loaded = useAgentStore((s) => s.loaded)
  const stopRun = useAgentStore((s) => s.stop)
  const deleteRun = useAgentStore((s) => s.delete)
  const approveRunPlan = useAgentStore((s) => s.approvePlan)
  const rejectRunPlan = useAgentStore((s) => s.rejectPlan)
  const projects = useProjectStore((s) => s.projects)
  const setActiveProject = useProjectStore((s) => s.setActive)
  const forkConversation = useChatStore((s) => s.forkConversation)
  const setView = useUiStore((s) => s.setView)
  const notify = useUiStore((s) => s.notify)

  const [creating, setCreating] = useState(false)
  const [retrySeed, setRetrySeed] = useState<AgentRunEditorSeed | null>(null)
  const [exampleSeed, setExampleSeed] = useState<AgentRunEditorSeed | null>(null)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [decidingId, setDecidingId] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [awayOnly, setAwayOnly] = useState(false)
  /** The finished run whose work is being put on a schedule, if any. */
  const [keepGoingId, setKeepGoingId] = useState<string | null>(null)

  const away = useAwayArrivals(runs, loaded)
  const listRef = useRef<HTMLDivElement>(null)
  const cardEls = useRef(new Map<string, HTMLDivElement>())
  const [beamTop, setBeamTop] = useState<number | null>(null)

  // The beam is positioned from the spotlit card's own box rather than a row
  // height guess, so it stays on the run it's announcing however tall that
  // card happens to be (goals wrap to two lines, summaries don't always exist).
  useEffect(() => {
    if (away.spotlightId === null) return
    const element = cardEls.current.get(away.spotlightId)
    if (!element) return
    setBeamTop(element.offsetTop + element.offsetHeight / 2)
  }, [away.spotlightId])

  // Read the drilled-into run from `runs` (not held in state) so a run finishing
  // or taking a turn while its log is open updates in place, never a stale copy.
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null
  // Across every run, not the filtered view: a series' length is a fact
  // about the work, not about what the list happens to be showing.
  const places = seriesPlaces(runs)
  const keepGoingRun = runs.find((run) => run.id === keepGoingId) ?? null

  const awayIds = new Set(away.runs.map((run) => run.id))
  const visibleRuns = awayOnly ? runs.filter((run) => awayIds.has(run.id)) : runs

  const closeEditor = (): void => {
    setCreating(false)
    setRetrySeed(null)
    setExampleSeed(null)
  }

  const retryRun = (run: AgentRun): void => {
    setRetrySeed({
      goal: run.goal,
      projectId: run.projectId,
      provider: run.provider,
      model: run.model,
      maxTurns: run.maxTurns,
      maxTokens: run.maxTokens,
      maxDurationMinutes: run.maxDurationMinutes,
      limitsEnabled: run.limitsEnabled,
      requirePlan: run.requirePlan,
      enabledTools: run.enabledTools,
      attachments: run.attachments?.map(({ path, name }) => ({ path, name }))
    })
  }

  /**
   * Start the next run of an ongoing piece of work.
   *
   * Everything but the series is seeded the way Retry does it, and for the
   * same reason: the settings are usually right and retyping them is the
   * tax. What makes this different from Retry is the one field it adds —
   * the new run reads what the previous ones did before it starts, so the
   * work carries on rather than starting over.
   */
  const continueRun = (run: AgentRun): void => {
    setRetrySeed({
      goal: run.goal,
      projectId: run.projectId,
      provider: run.provider,
      model: run.model,
      maxTurns: run.maxTurns,
      maxTokens: run.maxTokens,
      maxDurationMinutes: run.maxDurationMinutes,
      limitsEnabled: run.limitsEnabled,
      requirePlan: run.requirePlan,
      enabledTools: run.enabledTools,
      attachments: run.attachments?.map(({ path, name }) => ({ path, name })),
      continuesSeriesId: seriesIdOf(run)
    })
  }

  const projectName = (projectId: string | null): string | null =>
    projects.find((p) => p.id === projectId)?.name ?? null

  /**
   * Carries a run's log into an ordinary chat. The log itself stays read-only —
   * it's a record of what ran unattended — so this forks a fresh conversation
   * the user owns instead of reopening the run's own transcript for edits.
   */
  const continueInChat = async (run: AgentRun): Promise<void> => {
    if (!run.conversationId) {
      notify({
        kind: 'info',
        title: 'Nothing to continue',
        message: 'This run has not produced a conversation yet.'
      })
      return
    }
    const headline = goalHeadline(run.goal)
    const shortGoal = headline.length > 48 ? `${headline.slice(0, 48)}…` : headline
    const forkedId = await forkConversation(run.conversationId, `${shortGoal} (continued)`)
    if (!forkedId) {
      notify({
        kind: 'error',
        title: 'Could not continue',
        message: "This run's conversation is no longer available."
      })
      return
    }
    void setActiveProject(run.projectId)
    setView('chat')
  }

  const handleStop = async (run: AgentRun): Promise<void> => {
    setStoppingId(run.id)
    try {
      await stopRun(run.id)
    } finally {
      setStoppingId(null)
    }
  }

  const handleDelete = async (run: AgentRun): Promise<void> => {
    if (selectedRunId === run.id) setSelectedRunId(null)
    await deleteRun(run.id)
  }

  const handleApprove = async (run: AgentRun, plan?: Plan): Promise<void> => {
    setDecidingId(run.id)
    try {
      await approveRunPlan(run.id, plan)
    } finally {
      setDecidingId(null)
    }
  }

  const handleReject = async (run: AgentRun): Promise<void> => {
    setDecidingId(run.id)
    try {
      await rejectRunPlan(run.id)
    } finally {
      setDecidingId(null)
    }
  }

  const editor = (creating || retrySeed || exampleSeed) && (
    <AgentRunEditor seed={retrySeed ?? exampleSeed ?? undefined} onClose={closeEditor} />
  )

  // Drilled into one run: the whole pane becomes its log, the list a click away.
  if (selectedRun) {
    return (
      <div className={styles.view}>
        <AgentRunConversation
          run={selectedRun}
          subAgents={runs.filter((run) => run.parentRunId === selectedRun.id)}
          parentRun={runs.find((run) => run.id === selectedRun.parentRunId) ?? null}
          onOpenRun={setSelectedRunId}
          projectName={projectName(selectedRun.projectId)}
          stopping={stoppingId === selectedRun.id}
          deciding={decidingId === selectedRun.id}
          onBack={() => setSelectedRunId(null)}
          onStop={() => void handleStop(selectedRun)}
          onRetry={() => retryRun(selectedRun)}
          onDelete={() => void handleDelete(selectedRun)}
          onApprove={(plan) => void handleApprove(selectedRun, plan)}
          onReject={() => void handleReject(selectedRun)}
          onContinueInChat={() => void continueInChat(selectedRun)}
          onContinue={() => continueRun(selectedRun)}
          seriesPlace={places.get(selectedRun.id) ?? null}
        />
        {editor}
        {keepGoingRun && (
          <KeepGoingDialog run={keepGoingRun} onClose={() => setKeepGoingId(null)} />
        )}
      </div>
    )
  }

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.title}>Agents</h1>
          <p className={styles.subtitle}>
            Hand off a goal and Anodex works it unattended, checking in as it goes, until it
            finishes or runs out of turns.
          </p>
        </div>
        <Button
          variant="primary"
          iconLeft={<Icon name="plus" size={16} />}
          onClick={() => setCreating(true)}
        >
          New run
        </Button>
      </header>

      <div className={styles.body}>
        {away.runs.length > 0 && !away.dismissed && (
          <AwayBand
            runs={away.runs}
            filtered={awayOnly}
            onShow={() => setAwayOnly(true)}
            onClearFilter={() => setAwayOnly(false)}
            onDismiss={() => {
              setAwayOnly(false)
              away.dismiss()
            }}
          />
        )}

        {runs.length === 0 ? (
          <>
            <div className={styles.empty}>
              <Icon name="bot" size={40} className={styles.emptyIcon} />
              <p>No agent runs yet.</p>
            </div>
            <ExampleCards
              title="Hand off a goal"
              examples={AGENT_EXAMPLES.map((example) => ({
                icon: example.icon,
                title: example.title,
                description: example.description,
                onSelect: () => setExampleSeed(example.seed)
              }))}
            />
          </>
        ) : (
          <div className={styles.runList} ref={listRef}>
            {away.sweeping && beamTop !== null && (
              <span
                className={styles.sweepBeam}
                style={{ top: `${beamTop}px` }}
                aria-hidden="true"
              />
            )}
            {SECTION_ORDER.map((section) => {
              const groups = groupRunsByParent(visibleRuns).filter(
                ({ run }) => sectionOf(run) === section
              )
              if (groups.length === 0) return null
              return (
                <section
                  key={section}
                  className={styles.section}
                  aria-label={SECTION_LABEL[section]}
                >
                  <h2 className={styles.sectionHead}>
                    {SECTION_LABEL[section]}
                    {section !== 'finished' && <b>{groups.length}</b>}
                  </h2>
                  {groups.map(({ run, children }) => {
                    // Resolved once for the whole fan-out, because whether a
                    // label is usable depends on the other tasks — see
                    // `subAgentNames`.
                    const names = subAgentNames(
                      children.map((child) => child.delegatedTask ?? child.goal)
                    )
                    const card = (
                      entry: AgentRun,
                      subAgents: AgentRun[] = [],
                      subAgentIndex: number | null = null
                    ): JSX.Element => (
                      <RunCard
                        key={entry.id}
                        run={entry}
                        subAgents={subAgents}
                        subAgentIndex={subAgentIndex}
                        subAgentLabel={subAgentIndex === null ? null : names[subAgentIndex]}
                        seriesPlace={places.get(entry.id) ?? null}
                        stoppingId={stoppingId}
                        projectName={projectName}
                        openRun={(r) => setSelectedRunId(r.id)}
                        handleStop={(r) => void handleStop(r)}
                        retryRun={retryRun}
                        continueRun={continueRun}
                        keepGoing={(r) => setKeepGoingId(r.id)}
                        deleteRun={(r) => void handleDelete(r)}
                        orchestrated={away.orchestrated(entry.id)}
                        spotlit={away.spotlightId === entry.id}
                        cardRef={(element) => {
                          if (element) cardEls.current.set(entry.id, element)
                          else cardEls.current.delete(entry.id)
                        }}
                      />
                    )
                    if (children.length === 0) return card(run)
                    return (
                      <div key={run.id} className={styles.runGroup}>
                        {card(run, children)}
                        {/* Indented under the run that sent them out, so the
                            shape of a fan-out is legible without opening
                            anything. */}
                        <div className={styles.subRuns}>
                          {children.map((child, index) => card(child, [], index))}
                        </div>
                      </div>
                    )
                  })}
                </section>
              )
            })}
          </div>
        )}
      </div>

      {editor}
      {keepGoingRun && <KeepGoingDialog run={keepGoingRun} onClose={() => setKeepGoingId(null)} />}
    </div>
  )
}
