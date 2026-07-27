import { useState } from 'react'
import type { AgentRun, AgentRunStatus } from '@shared/agentRun.types'
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
  STATUS_ICON,
  STATUS_LABEL,
  formatCompactTokens,
  isTerminalStatus,
  providerIcon,
  providerLabel
} from './agentRunFormat'
import styles from './AgentView.module.css'

/**
 * True for one render pass when a run reaches a terminal status the user
 * hasn't been shown yet. A run reaches a terminal status exactly once, so its
 * own id identifies the landing — unlike a scheduled task, which runs again
 * and again and has to fold in which run.
 *
 * Only used for a lone arrival: when several runs land together the view
 * sequences them itself (see `useAwayArrivals`) rather than letting every card
 * announce independently.
 */
function useJustArrived(run: AgentRun): boolean {
  return useArrival(isTerminalStatus(run.status) ? run.id : null, run.updatedAt)
}

type StatusFilter = AgentRunStatus | 'all'

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'needs-review', label: 'Needs review' },
  { value: 'done', label: 'Done' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'error', label: 'Error' }
]

function RunCard({
  run,
  stoppingId,
  projectName,
  openRun,
  handleStop,
  retryRun,
  deleteRun
}: {
  run: AgentRun
  stoppingId: string | null
  projectName: (projectId: string | null) => string | null
  openRun: (run: AgentRun) => void
  handleStop: (run: AgentRun) => void
  retryRun: (run: AgentRun) => void
  deleteRun: (run: AgentRun) => void
}): JSX.Element {
  const justArrived = useJustArrived(run)

  return (
    <div
      className={`${styles.runCard} ${styles[`runCard-${run.status}`]} ${
        justArrived ? styles.arrived : ''
      }`}
    >
      {run.status === 'running' && (
        <span className={styles.cometEdge} aria-hidden="true">
          <span className={styles.cometHalo} />
          <span className={styles.cometCore} />
        </span>
      )}
      <div className={styles.runRow}>
        <button type="button" className={styles.runMain} onClick={() => openRun(run)}>
          <div className={styles.runTitleRow}>
            <span className={`${styles.statusBadge} ${styles[`status-${run.status}`]}`}>
              <Icon name={STATUS_ICON[run.status]} size={12} />
              {STATUS_LABEL[run.status]}
              {run.status === 'running' &&
                (run.limitsEnabled
                  ? ` · turn ${run.turnsUsed}/${run.maxTurns} · ${formatCompactTokens(run.tokensUsed)}/${formatCompactTokens(run.maxTokens)} tokens`
                  : ` · turn ${run.turnsUsed} · ${formatCompactTokens(run.tokensUsed)} tokens (unlimited)`)}
            </span>
            {projectName(run.projectId) && (
              <span className={styles.runProject}>{projectName(run.projectId)}</span>
            )}
          </div>
          <p className={styles.runGoal}>{run.goal}</p>
          <div className={styles.runMeta}>
            <span>{formatRelativeTime(run.updatedAt)}</span>
            <span className={styles.runProvider}>
              <Icon name={providerIcon(run)} size={12} />
              {providerLabel(run)}
            </span>
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
          </div>
          {(run.summary || run.lastError) && (
            <p
              className={`${styles.runResult} ${
                run.status === 'error'
                  ? styles.runResultError
                  : run.status === 'stopped' && run.lastError
                    ? styles.runResultWarn
                    : ''
              }`}
            >
              {run.status === 'error' ? 'Failed: ' : ''}
              {run.summary ?? run.lastError}
            </p>
          )}
        </button>
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
          <button
            type="button"
            className={styles.iconAction}
            onClick={() => retryRun(run)}
            aria-label="Retry with these settings"
            title="Retry with these settings"
          >
            <Icon name="refresh" size={14} />
          </button>
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
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [decidingId, setDecidingId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)

  // Read the drilled-into run from `runs` (not held in state) so a run finishing
  // or taking a turn while its log is open updates in place, never a stale copy.
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null

  const visibleRuns =
    statusFilter === 'all' ? runs : runs.filter((run) => run.status === statusFilter)

  const closeEditor = (): void => {
    setCreating(false)
    setRetrySeed(null)
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
      enabledTools: run.enabledTools
    })
  }

  const projectName = (projectId: string | null): string | null =>
    projects.find((p) => p.id === projectId)?.name ?? null

  /**
   * Carries a run's log into an ordinary chat. The log itself stays read-only —
   * it's a record of what ran unattended — so this forks a fresh conversation
   * the user owns instead of reopening the run's own transcript for edits.
   */
  const continueInChat = (run: AgentRun): void => {
    if (!run.conversationId) {
      notify({
        kind: 'info',
        title: 'Nothing to continue',
        message: 'This run has not produced a conversation yet.'
      })
      return
    }
    const shortGoal = run.goal.length > 48 ? `${run.goal.slice(0, 48)}…` : run.goal
    const forkedId = forkConversation(run.conversationId, `${shortGoal} (continued)`)
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

  const handleApprove = async (run: AgentRun): Promise<void> => {
    setDecidingId(run.id)
    try {
      await approveRunPlan(run.id)
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

  const editor = (creating || retrySeed) && (
    <AgentRunEditor seed={retrySeed ?? undefined} onClose={closeEditor} />
  )

  // Drilled into one run: the whole pane becomes its log, the list a click away.
  if (selectedRun) {
    return (
      <div className={styles.view}>
        <AgentRunConversation
          run={selectedRun}
          projectName={projectName(selectedRun.projectId)}
          stopping={stoppingId === selectedRun.id}
          deciding={decidingId === selectedRun.id}
          onBack={() => setSelectedRunId(null)}
          onStop={() => void handleStop(selectedRun)}
          onRetry={() => retryRun(selectedRun)}
          onDelete={() => void handleDelete(selectedRun)}
          onApprove={() => void handleApprove(selectedRun)}
          onReject={() => void handleReject(selectedRun)}
          onContinueInChat={() => continueInChat(selectedRun)}
        />
        {editor}
      </div>
    )
  }

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.title}>Agent</h1>
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
        {runs.length > 0 && (
          <div className={styles.filterRow}>
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                className={`${styles.filterTab} ${statusFilter === filter.value ? styles.filterTabActive : ''}`}
                onClick={() => setStatusFilter(filter.value)}
                aria-pressed={statusFilter === filter.value}
              >
                {filter.label}
              </button>
            ))}
          </div>
        )}

        {runs.length === 0 ? (
          <div className={styles.empty}>
            <Icon name="bot" size={40} className={styles.emptyIcon} />
            <p>No agent runs yet.</p>
          </div>
        ) : visibleRuns.length === 0 ? (
          <div className={styles.empty}>
            <p>No {statusFilter} runs.</p>
          </div>
        ) : (
          <div className={styles.runList}>
            {visibleRuns.map((run) => (
              <RunCard
                key={run.id}
                run={run}
                stoppingId={stoppingId}
                projectName={projectName}
                openRun={(r) => setSelectedRunId(r.id)}
                handleStop={(r) => void handleStop(r)}
                retryRun={retryRun}
                deleteRun={(r) => void handleDelete(r)}
              />
            ))}
          </div>
        )}
      </div>

      {editor}
    </div>
  )
}
