import { useState } from 'react'
import type { AgentRun, AgentRunStatus } from '@shared/agentRun.types'
import { ANTHROPIC_MODELS } from '@shared/anthropicModels'
import { OPENAI_MODELS } from '@shared/openaiModels'
import { Icon, type IconName } from '../../components/Icon'
import { Button } from '../../components/ui/Button'
import { useAgentStore } from '../../stores/agentStore'
import { useProjectStore } from '../../stores/projectStore'
import { useChatStore } from '../../stores/chatStore'
import { useUiStore } from '../../stores/uiStore'
import { formatRelativeTime } from '../../lib/time'
import { AgentRunEditor, type AgentRunEditorSeed } from './AgentRunEditor'
import styles from './AgentView.module.css'

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

const STATUS_ICON: Record<AgentRunStatus, IconName> = {
  running: 'activity',
  done: 'check',
  stopped: 'stop',
  error: 'alert'
}

const STATUS_LABEL: Record<AgentRunStatus, string> = {
  running: 'Running',
  done: 'Done',
  stopped: 'Stopped',
  error: 'Error'
}

/**
 * Dedicated main view for autonomous agent runs — replaces the chat pane the
 * same way `SchedulerView` does (inline, not a popup or separate window).
 */
export function AgentView(): JSX.Element {
  const runs = useAgentStore((s) => s.runs)
  const stopRun = useAgentStore((s) => s.stop)
  const deleteRun = useAgentStore((s) => s.delete)
  const projects = useProjectStore((s) => s.projects)
  const setActiveProject = useProjectStore((s) => s.setActive)
  const selectConversation = useChatStore((s) => s.selectConversation)
  const setView = useUiStore((s) => s.setView)
  const notify = useUiStore((s) => s.notify)

  const [creating, setCreating] = useState(false)
  const [retrySeed, setRetrySeed] = useState<AgentRunEditorSeed | null>(null)
  const [stoppingId, setStoppingId] = useState<string | null>(null)

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
      enabledTools: run.enabledTools
    })
  }

  const projectName = (projectId: string | null): string | null =>
    projects.find((p) => p.id === projectId)?.name ?? null

  const openConversation = (run: AgentRun): void => {
    if (!run.conversationId) {
      notify({ kind: 'info', title: 'Nothing to show yet', message: 'This run has not started yet.' })
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

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <h1 className={styles.title}>Agent</h1>
        <Button variant="primary" iconLeft={<Icon name="plus" size={16} />} onClick={() => setCreating(true)}>
          New run
        </Button>
      </div>
      <p className={styles.subtitle}>
        Hand off a goal and Anodex works it unattended, checking in as it goes, until it finishes or
        runs out of turns.
      </p>

      {runs.length === 0 ? (
        <div className={styles.empty}>
          <Icon name="wand" size={40} className={styles.emptyIcon} />
          <p>No agent runs yet.</p>
        </div>
      ) : (
        <div className={styles.runList}>
          {runs.map((run) => (
            <div key={run.id} className={styles.runCard}>
              <button type="button" className={styles.runMain} onClick={() => openConversation(run)}>
                <div className={styles.runTitleRow}>
                  <span className={`${styles.statusBadge} ${styles[`status-${run.status}`]}`}>
                    <Icon name={STATUS_ICON[run.status]} size={12} />
                    {STATUS_LABEL[run.status]}
                    {run.status === 'running' && ` · turn ${run.turnsUsed}/${run.maxTurns}`}
                  </span>
                  {projectName(run.projectId) && (
                    <span className={styles.runProject}>{projectName(run.projectId)}</span>
                  )}
                </div>
                <p className={styles.runGoal}>{run.goal}</p>
                <div className={styles.runMeta}>
                  <span>{formatRelativeTime(run.updatedAt)}</span>
                  <span>{providerLabel(run)}</span>
                </div>
                {(run.summary || run.lastError) && (
                  <p className={`${styles.runResult} ${run.lastError ? styles.runResultError : ''}`}>
                    {run.lastError ? 'Failed: ' : ''}
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
                  title={run.status === 'running' ? 'Stop the run before deleting it' : 'Delete run'}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
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
