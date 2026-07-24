import { useEffect, useMemo, useRef, useState } from 'react'
import type { ScheduledTask } from '@shared/scheduledTask.types'
import type { IconName } from '../../components/Icon'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/ui/Button'
import { Spinner } from '../../components/ui/Spinner'
import { SidebarSearch } from '../../components/sidebar/SidebarSearch'
import { ToggleControl, SelectControl } from '../settings/controls'
import { useSchedulerStore } from '../../stores/schedulerStore'
import { useProjectStore } from '../../stores/projectStore'
import { useChatStore } from '../../stores/chatStore'
import { useUiStore } from '../../stores/uiStore'
import { formatRelativeTime } from '../../lib/time'
import { describeRecurrence, formatNextRun } from './scheduleFormat'
import { SchedulerTaskEditor, type SchedulerTaskEditorSeed } from './SchedulerTaskEditor'
import { SchedulerConversation } from './SchedulerConversation'
import { useCountdown } from './useCountdown'
import styles from './SchedulerView.module.css'

type SortMode = 'nextRun' | 'name'

interface Example {
  icon: IconName
  title: string
  description: string
  seed: SchedulerTaskEditorSeed
}

const EXAMPLES: Example[] = [
  {
    icon: 'monitor',
    title: 'Daily project check-in',
    description:
      'Summarize what changed in this project since yesterday and flag anything unfinished.',
    seed: {
      name: 'Daily project check-in',
      prompt:
        'Summarize what changed in this project since yesterday and flag anything that looks unfinished.',
      recurrence: { type: 'daily', hour: 8, minute: 0 },
      enabledTools: []
    }
  },
  {
    icon: 'layers',
    title: 'Weekly summary',
    description: "A short summary of this week's work in this project, every Friday afternoon.",
    seed: {
      name: 'Weekly summary',
      prompt: "Write a short summary of this week's work in this project.",
      recurrence: { type: 'weekly', hour: 16, minute: 0, weekdays: [5] },
      enabledTools: []
    }
  },
  {
    icon: 'globe',
    title: 'Watch for updates',
    description: 'Search the web each morning for news on a topic you care about.',
    seed: {
      name: 'Watch for updates',
      prompt: 'Search the web for major news about <topic> and summarize anything new.',
      recurrence: { type: 'daily', hour: 9, minute: 0 },
      enabledTools: ['fetch_url', 'web_search']
    }
  },
  {
    icon: 'cpu',
    title: 'Dependency check',
    description: 'Check for outdated or vulnerable dependencies, once a week.',
    seed: {
      name: 'Dependency check',
      prompt: 'Check package.json for outdated or vulnerable dependencies and report back.',
      recurrence: { type: 'weekly', hour: 9, minute: 0, weekdays: [1] },
      enabledTools: ['read_file']
    }
  }
]

/** IDs of tasks whose "just arrived" card animation has already played this
 *  session — see the same mechanism (and reasoning) in AgentView.tsx. */
const announcedTaskRuns = new Set<string>()
const ARRIVAL_WINDOW_MS = 5 * 60 * 1000

/**
 * True for one render pass when a task's most recent run just landed and
 * the user hasn't been shown it — including opening Scheduler for the first
 * time after an unattended run already finished. Keyed on `lastRunAt` (not
 * just the task id) so a *later* run on the same task can announce itself
 * again after the first one already has.
 */
function useJustArrived(task: ScheduledTask): boolean {
  const isTerminal = task.lastRunAt !== null
  const announceKey = `${task.id}:${task.lastRunAt}`
  const [justArrived, setJustArrived] = useState(false)
  const announcedRef = useRef(false)

  useEffect(() => {
    if (!isTerminal || task.lastRunAt === null) return
    if (announcedRef.current || announcedTaskRuns.has(announceKey)) return
    if (Date.now() - task.lastRunAt > ARRIVAL_WINDOW_MS) return
    announcedTaskRuns.add(announceKey)
    announcedRef.current = true
    setJustArrived(true)
  }, [announceKey, isTerminal, task.lastRunAt])

  return justArrived
}

function TaskCard({
  task,
  runningId,
  projectName,
  onOpenReport,
  onRunNow,
  onEdit
}: {
  task: ScheduledTask
  runningId: string | null
  projectName: (projectId: string | null) => string | null
  onOpenReport: (id: string) => void
  onRunNow: (task: ScheduledTask) => void
  onEdit: (task: ScheduledTask) => void
}): JSX.Element {
  const justArrived = useJustArrived(task)
  const lastRunClass = task.lastRunAt ? styles[`taskCard-${task.lastRunStatus ?? 'success'}`] : ''
  // Re-renders this card on a timer so its next-run label counts down instead
  // of freezing at whatever it read when the list was last drawn.
  useCountdown(task.enabled ? task.nextRunAt : null)

  return (
    <div className={`${styles.taskCard} ${lastRunClass} ${justArrived ? styles.arrived : ''}`}>
      <button type="button" className={styles.taskMain} onClick={() => onOpenReport(task.id)}>
        <div className={styles.taskTitleRow}>
          <span className={styles.taskName}>{task.name}</span>
          {projectName(task.projectId) && (
            <span className={styles.taskProject}>{projectName(task.projectId)}</span>
          )}
        </div>
        <p className={styles.taskPrompt}>{task.prompt}</p>
        <div className={styles.taskMeta}>
          <span>
            <Icon name="calendar" size={12} /> {describeRecurrence(task.recurrence)}
          </span>
          <span className={styles.countdown}>
            {task.enabled ? formatNextRun(task.nextRunAt) : 'Paused'}
          </span>
          {task.lastRunAt && (
            <span
              className={`${styles.lastRun} ${styles[`status-${task.lastRunStatus ?? 'success'}`]}`}
            >
              Last run {formatRelativeTime(task.lastRunAt)}
            </span>
          )}
        </div>
        {task.lastRunSummary && (
          <p
            className={`${styles.lastRunSummary} ${
              task.lastRunStatus === 'error' ? styles.lastRunSummaryError : ''
            }`}
          >
            {task.lastRunStatus === 'error' ? 'Failed: ' : ''}
            {task.lastRunSummary}
          </p>
        )}
      </button>
      <div className={styles.taskActions}>
        <ToggleControl
          checked={task.enabled}
          onChange={(value) =>
            void useSchedulerStore.getState().update(task.id, { enabled: value })
          }
        />
        <button
          type="button"
          className={styles.iconAction}
          onClick={() => onRunNow(task)}
          disabled={runningId === task.id}
          aria-label="Run now"
          title="Run now"
        >
          {runningId === task.id ? <Spinner size={14} /> : <Icon name="send" size={14} />}
        </button>
        <button
          type="button"
          className={styles.iconAction}
          onClick={() => onEdit(task)}
          aria-label="Edit task"
          title="Edit task"
        >
          <Icon name="pencil" size={14} />
        </button>
        <button
          type="button"
          className={styles.iconAction}
          onClick={() => void useSchedulerStore.getState().delete(task.id)}
          aria-label="Delete task"
          title="Delete task"
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  )
}

/**
 * Dedicated main view for managing scheduled tasks — replaces the chat pane
 * the same way `AppShell` already swaps in Settings, but inline instead of an
 * overlay (the user's own call: this reads as a first-class page, not a
 * dialog on top of chat).
 */
export function SchedulerView(): JSX.Element {
  const tasks = useSchedulerStore((s) => s.tasks)
  const keepAwake = useSchedulerStore((s) => s.keepAwake)
  const setKeepAwake = useSchedulerStore((s) => s.setKeepAwake)
  const runNow = useSchedulerStore((s) => s.runNow)
  const projects = useProjectStore((s) => s.projects)
  const setActiveProject = useProjectStore((s) => s.setActive)
  const forkConversation = useChatStore((s) => s.forkConversation)
  const setView = useUiStore((s) => s.setView)
  const notify = useUiStore((s) => s.notify)

  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('nextRun')
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null)
  const [creatingSeed, setCreatingSeed] = useState<SchedulerTaskEditorSeed | null>(null)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)

  const editorOpen = editingTask !== null || creatingSeed !== null
  // Read from `tasks` rather than held in state, so a run finishing while its
  // conversation is open updates in place instead of showing a stale snapshot.
  const openTask = tasks.find((task) => task.id === openTaskId) ?? null

  const filteredTasks = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = q
      ? tasks.filter(
          (task) => task.name.toLowerCase().includes(q) || task.prompt.toLowerCase().includes(q)
        )
      : tasks

    return [...matches].sort((a, b) => {
      if (sortMode === 'name')
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      if (a.nextRunAt === null && b.nextRunAt === null) return b.updatedAt - a.updatedAt
      if (a.nextRunAt === null) return 1
      if (b.nextRunAt === null) return -1
      return a.nextRunAt - b.nextRunAt
    })
  }, [tasks, query, sortMode])

  const projectName = (projectId: string | null): string | null =>
    projects.find((p) => p.id === projectId)?.name ?? null

  /**
   * Carries a task's run log into an ordinary chat. The log itself stays
   * read-only — it's a record of what ran unattended, and letting replies land
   * in it would mean the next run inherits a side conversation as context.
   */
  const continueInChat = (task: ScheduledTask): void => {
    if (!task.conversationId) {
      notify({ kind: 'info', title: 'Nothing to continue', message: 'This task has not run yet.' })
      return
    }
    const forkedId = forkConversation(task.conversationId, `${task.name} (continued)`)
    if (!forkedId) {
      notify({
        kind: 'error',
        title: 'Could not continue',
        message: "This task's conversation is no longer available."
      })
      return
    }
    void setActiveProject(task.projectId)
    setView('chat')
  }

  const handleRunNow = async (task: ScheduledTask): Promise<void> => {
    setRunningId(task.id)
    try {
      await runNow(task.id)
    } finally {
      setRunningId(null)
    }
  }

  // Drilled into one task: the whole pane becomes its run log, with the list
  // one click away. The editor stays mounted so "Edit" works from in here too.
  if (openTask) {
    return (
      <div className={styles.view}>
        <SchedulerConversation
          task={openTask}
          running={runningId === openTask.id}
          onBack={() => setOpenTaskId(null)}
          onRunNow={() => void handleRunNow(openTask)}
          onEdit={() => setEditingTask(openTask)}
          onContinueInChat={() => continueInChat(openTask)}
        />
        {editorOpen && (
          <SchedulerTaskEditor
            task={editingTask}
            seed={creatingSeed ?? undefined}
            onClose={() => {
              setEditingTask(null)
              setCreatingSeed(null)
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <h1 className={styles.title}>Scheduled tasks</h1>
        <div className={styles.headerActions}>
          <SelectControl
            value={sortMode}
            onChange={(value) => setSortMode(value as SortMode)}
            options={[
              { label: 'Sort by: Next run', value: 'nextRun' },
              { label: 'Sort by: Name', value: 'name' }
            ]}
          />
          <Button
            variant="primary"
            iconLeft={<Icon name="plus" size={16} />}
            onClick={() => setCreatingSeed({})}
          >
            New task
          </Button>
        </div>
      </div>
      <p className={styles.subtitle}>
        Run tasks on a schedule, using only the tools you allow. Type a prompt, pick when it runs,
        and Anodex takes it from there.
      </p>

      <SidebarSearch value={query} onChange={setQuery} />

      <div className={styles.infoBar}>
        <span>
          <Icon name="info" size={14} /> Scheduled tasks only run while Anodex is open.
        </span>
        <label className={styles.keepAwake}>
          <Icon name="power" size={14} />
          Keep awake
          <ToggleControl checked={keepAwake} onChange={(value) => void setKeepAwake(value)} />
        </label>
      </div>

      {filteredTasks.length === 0 ? (
        <div className={styles.empty}>
          <Icon name="clock" size={40} className={styles.emptyIcon} />
          <p>{tasks.length === 0 ? 'No scheduled tasks yet.' : 'No tasks match your search.'}</p>
        </div>
      ) : (
        <div className={styles.taskList}>
          {filteredTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              runningId={runningId}
              projectName={projectName}
              onOpenReport={setOpenTaskId}
              onRunNow={(t) => void handleRunNow(t)}
              onEdit={setEditingTask}
            />
          ))}
        </div>
      )}

      <div className={styles.divider} />

      <div className={styles.examples}>
        <h2 className={styles.examplesTitle}>Get started with an example</h2>
        <div className={styles.exampleGrid}>
          {EXAMPLES.map((example) => (
            <button
              key={example.title}
              type="button"
              className={styles.exampleCard}
              onClick={() => setCreatingSeed(example.seed)}
            >
              <div className={styles.exampleIcon}>
                <Icon name={example.icon} size={16} />
              </div>
              <div>
                <p className={styles.exampleTitle}>{example.title}</p>
                <p className={styles.exampleDescription}>{example.description}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {editorOpen && (
        <SchedulerTaskEditor
          task={editingTask}
          seed={creatingSeed ?? undefined}
          onClose={() => {
            setEditingTask(null)
            setCreatingSeed(null)
          }}
        />
      )}
    </div>
  )
}
