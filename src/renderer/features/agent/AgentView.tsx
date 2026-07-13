import { useState } from 'react'
import type { AgentRun, AgentRunStatus } from '@shared/agentRun.types'
import type { Plan } from '@shared/plan.types'
import { ANTHROPIC_MODELS } from '@shared/anthropicModels'
import { OPENAI_MODELS } from '@shared/openaiModels'
import { Icon, type IconName } from '../../components/Icon'
import { Spinner } from '../../components/ui/Spinner'
import { Button } from '../../components/ui/Button'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { useChatStore } from '../../stores/chatStore'
import { useUiStore } from '../../stores/uiStore'
import { formatRelativeTime } from '../../lib/time'
import { AgentRunEditor, type AgentRunEditorSeed } from './AgentRunEditor'
import styles from './AgentView.module.css'

/** Compact step-list preview of a run's plan — same visual shape as the Workspace Dock's PlanPanel. */
function PlanPreview({ plan }: { plan: Plan }): JSX.Element {
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

/** Short "backend used" label for a run card, e.g. "Local", "Claude · Claude Sonnet 5". */
function providerLabel(run: AgentRun): string {
  if (run.provider === 'local') return 'Local'
  if (run.provider === 'anthropic') {
    const label = ANTHROPIC_MODELS.find((m) => m.id === run.model)?.label ?? run.model
    return `Claude${label ? ` · ${label}` : ''}`
  }
  const label = OPENAI_MODELS.find((m) => m.id === run.model)?.label ?? run.model
  return `OpenAI${label ? ` · ${label}` : ''}`
}

/** Local runs use the engine icon; cloud runs (Claude/OpenAI) share a generic cloud-model icon. */
function providerIcon(run: AgentRun): IconName {
  return run.provider === 'local' ? 'cpu' : 'sparkle'
}

/** Compact token count for the live status badge, e.g. 12400 -> "12.4k". */
function formatCompactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

const STATUS_ICON: Record<AgentRunStatus, IconName> = {
  running: 'activity',
  'needs-review': 'eye',
  done: 'check',
  stopped: 'stop',
  error: 'alert'
}

const STATUS_LABEL: Record<AgentRunStatus, string> = {
  running: 'Running',
  'needs-review': 'Needs review',
  done: 'Done',
  stopped: 'Stopped',
  error: 'Error'
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

/**
 * Dedicated main view for autonomous agent runs — replaces the chat pane the
 * same way `SchedulerView` does (inline, not a popup or separate window).
 */
export function AgentView(): JSX.Element {
  const runs = useAgentStore((s) => s.runs)
  const stopRun = useAgentStore((s) => s.stop)
  const deleteRun = useAgentStore((s) => s.delete)
  const approveRunPlan = useAgentStore((s) => s.approvePlan)
  const rejectRunPlan = useAgentStore((s) => s.rejectPlan)
  const projects = useProjectStore((s) => s.projects)
  const setActiveProject = useProjectStore((s) => s.setActive)
  const selectConversation = useChatStore((s) => s.selectConversation)
  const setView = useUiStore((s) => s.setView)
  const notify = useUiStore((s) => s.notify)

  const [creating, setCreating] = useState(false)
  const [retrySeed, setRetrySeed] = useState<AgentRunEditorSeed | null>(null)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [decidingId, setDecidingId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

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

  const openConversation = (run: AgentRun): void => {
    if (!run.conversationId) {
      notify({
        kind: 'info',
        title: 'Nothing to show yet',
        message: 'This run has not started yet.'
      })
      return
    }
    void setActiveProject(run.projectId)
    void selectConversation(run.conversationId)
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

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <h1 className={styles.title}>Agent</h1>
        <Button
          variant="primary"
          iconLeft={<Icon name="plus" size={16} />}
          onClick={() => setCreating(true)}
        >
          New run
        </Button>
      </div>
      <p className={styles.subtitle}>
        Hand off a goal and Anodex works it unattended, checking in as it goes, until it finishes or
        runs out of turns.
      </p>

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
          <Icon name="wand" size={40} className={styles.emptyIcon} />
          <p>No agent runs yet.</p>
        </div>
      ) : visibleRuns.length === 0 ? (
        <div className={styles.empty}>
          <p>No {statusFilter} runs.</p>
        </div>
      ) : (
        <div className={styles.runList}>
          {visibleRuns.map((run) => (
            <div key={run.id} className={`${styles.runCard} ${styles[`runCard-${run.status}`]}`}>
              <div className={styles.runRow}>
                <button
                  type="button"
                  className={styles.runMain}
                  onClick={() => openConversation(run)}
                >
                  <div className={styles.runTitleRow}>
                    <span className={`${styles.statusBadge} ${styles[`status-${run.status}`]}`}>
                      <Icon
                        name={STATUS_ICON[run.status]}
                        size={12}
                        className={run.status === 'running' ? styles.pulseIcon : undefined}
                      />
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
                    onClick={() => openConversation(run)}
                    disabled={!run.conversationId}
                    aria-label="Open conversation"
                    title="Open conversation"
                  >
                    <Icon name="send" size={14} />
                  </button>
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
                    onClick={() => void deleteRun(run.id)}
                    disabled={run.status === 'running'}
                    aria-label="Delete run"
                    title={
                      run.status === 'running' ? 'Stop the run before deleting it' : 'Delete run'
                    }
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </div>
              {run.status === 'needs-review' && run.plan && (
                <div className={styles.planReview}>
                  <PlanPreview plan={run.plan} />
                  <div className={styles.planReviewActions}>
                    <Button
                      variant="secondary"
                      onClick={() => void handleReject(run)}
                      disabled={decidingId === run.id}
                    >
                      Reject
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => void handleApprove(run)}
                      loading={decidingId === run.id}
                    >
                      Approve
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {(creating || retrySeed) && (
        <AgentRunEditor seed={retrySeed ?? undefined} onClose={closeEditor} />
      )}
    </div>
  )
}
