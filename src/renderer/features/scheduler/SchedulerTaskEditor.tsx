import { useState } from 'react'
import type {
  IntervalUnit,
  RecurrenceType,
  ScheduledTask,
  TaskRecurrence
} from '@shared/scheduledTask.types'
import { MIN_INTERVAL_MINUTES } from '@shared/scheduledTask.types'
import { TOOL_CATALOG, type ToolKind } from '@shared/tools.types'
import { useProjectStore } from '../../stores/projectStore'
import { useSchedulerStore } from '../../stores/schedulerStore'
import { Overlay } from '../../components/ui/Overlay'
import { Button } from '../../components/ui/Button'
import { Icon } from '../../components/Icon'
import { SelectControl } from '../settings/controls'
import styles from './SchedulerTaskEditor.module.css'

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const WEEKDAYS_PRESET = [1, 2, 3, 4, 5]

const KIND_ORDER: ToolKind[] = ['web', 'read', 'write', 'command', 'plan', 'mcp']
const KIND_LABELS: Record<ToolKind, string> = {
  web: 'Web',
  read: 'Read files',
  write: 'Edit files',
  command: 'Run commands',
  plan: 'Planning',
  mcp: 'MCP servers'
}
/** Shown under a risky group — there's no one present to click an approval prompt during a scheduled run. */
const KIND_RISK_NOTE: Partial<Record<ToolKind, string>> = {
  write: 'Runs automatically without asking, every time this task fires.',
  command: 'Runs automatically without asking, every time this task fires.'
}

export interface SchedulerTaskEditorSeed {
  name?: string
  prompt?: string
  recurrence?: TaskRecurrence
  enabledTools?: string[]
}

interface SchedulerTaskEditorProps {
  /** The task being edited, or null when creating a new one. */
  task: ScheduledTask | null
  /** Prefilled values when creating from an example card. Ignored when `task` is set. */
  seed?: SchedulerTaskEditorSeed
  onClose: () => void
}

function timeToInput(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function inputToTime(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(':').map((part) => Number(part))
  return { hour: hour || 0, minute: minute || 0 }
}

/** Create/edit form for a scheduled task: prompt, project scope, recurrence, and per-tool access. */
export function SchedulerTaskEditor({
  task,
  seed,
  onClose
}: SchedulerTaskEditorProps): JSX.Element {
  const projects = useProjectStore((s) => s.projects)
  const createTask = useSchedulerStore((s) => s.create)
  const updateTask = useSchedulerStore((s) => s.update)
  const deleteTask = useSchedulerStore((s) => s.delete)

  const initialRecurrence: TaskRecurrence = task?.recurrence ??
    seed?.recurrence ?? { type: 'daily', hour: 9, minute: 0 }

  const [name, setName] = useState(task?.name ?? seed?.name ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? seed?.prompt ?? '')
  const [projectId, setProjectId] = useState<string | null>(task?.projectId ?? null)
  const [recurrenceType, setRecurrenceType] = useState<RecurrenceType>(initialRecurrence.type)
  const [time, setTime] = useState(timeToInput(initialRecurrence.hour, initialRecurrence.minute))
  const [weekdays, setWeekdays] = useState<number[]>(
    initialRecurrence.weekdays && initialRecurrence.weekdays.length > 0
      ? initialRecurrence.weekdays
      : WEEKDAYS_PRESET
  )
  const [every, setEvery] = useState(initialRecurrence.every ?? 30)
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>(
    initialRecurrence.intervalUnit ?? 'minutes'
  )
  const [enabledTools, setEnabledTools] = useState<Set<string>>(
    new Set(task?.enabledTools ?? seed?.enabledTools ?? ['fetch_url', 'web_search'])
  )
  const [saving, setSaving] = useState(false)

  const hasProject = projectId !== null
  const availableTools = TOOL_CATALOG.filter((tool) => !tool.requiresProject || hasProject)
  const canSave =
    prompt.trim().length > 0 &&
    (recurrenceType !== 'weekly' || weekdays.length > 0) &&
    (recurrenceType !== 'interval' || every >= 1)

  const toggleTool = (toolName: string): void => {
    setEnabledTools((prev) => {
      const next = new Set(prev)
      if (next.has(toolName)) next.delete(toolName)
      else next.add(toolName)
      return next
    })
  }

  const selectAllTools = (): void => setEnabledTools(new Set(availableTools.map((t) => t.name)))
  const clearAllTools = (): void => setEnabledTools(new Set())

  const toggleWeekday = (day: number): void => {
    setWeekdays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()))
  }

  const handleSave = async (): Promise<void> => {
    if (!canSave || saving) return
    setSaving(true)
    const { hour, minute } = inputToTime(time)
    const recurrence: TaskRecurrence =
      recurrenceType === 'weekly'
        ? { type: 'weekly', hour, minute, weekdays }
        : recurrenceType === 'interval'
          ? {
              type: 'interval',
              hour: 0,
              minute: 0,
              every: intervalUnit === 'minutes' ? Math.max(every, MIN_INTERVAL_MINUTES) : every,
              intervalUnit
            }
          : { type: recurrenceType, hour, minute }

    const request = {
      name: name.trim() || undefined,
      prompt: prompt.trim(),
      projectId,
      recurrence,
      enabledTools: [...enabledTools].filter((toolName) =>
        availableTools.some((tool) => tool.name === toolName)
      )
    }

    if (task) {
      await updateTask(task.id, request)
    } else {
      await createTask(request)
    }
    setSaving(false)
    onClose()
  }

  const handleDelete = async (): Promise<void> => {
    if (!task) return
    await deleteTask(task.id)
    onClose()
  }

  return (
    <Overlay onClose={onClose} ariaLabel={task ? 'Edit scheduled task' : 'New scheduled task'} cardClassName={styles.card}>
      <div className={styles.header}>
        <h2 className={styles.title}>{task ? 'Edit task' : 'New scheduled task'}</h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close" title="Close">
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className={styles.body}>
        <label className={styles.field}>
          <span className={styles.label}>What should Anodex do?</span>
          <textarea
            className={styles.textarea}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="e.g. Summarize what changed in this project since yesterday."
            rows={3}
            autoFocus
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Name (optional)</span>
          <input
            className={styles.input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Named after the prompt if left blank"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Project</span>
          <SelectControl
            value={projectId ?? ''}
            onChange={(value) => setProjectId(value || null)}
            options={[
              { label: 'No project (plain chat)', value: '' },
              ...projects.map((project) => ({ label: project.name, value: project.id }))
            ]}
          />
        </label>

        <div className={styles.field}>
          <span className={styles.label}>Repeat</span>
          <div className={styles.recurrenceRow}>
            <SelectControl
              value={recurrenceType}
              onChange={(value) => setRecurrenceType(value as RecurrenceType)}
              options={[
                { label: 'Once', value: 'once' },
                { label: 'Daily', value: 'daily' },
                { label: 'Weekly', value: 'weekly' },
                { label: 'Every...', value: 'interval' }
              ]}
            />
            {recurrenceType === 'interval' ? (
              <>
                <span className={styles.intervalWord}>Every</span>
                <input
                  type="number"
                  min={intervalUnit === 'minutes' ? MIN_INTERVAL_MINUTES : 1}
                  className={styles.intervalNumber}
                  value={every}
                  onChange={(event) => setEvery(Number(event.target.value) || 1)}
                />
                <SelectControl
                  value={intervalUnit}
                  onChange={(value) => setIntervalUnit(value as IntervalUnit)}
                  options={[
                    { label: 'minutes', value: 'minutes' },
                    { label: 'hours', value: 'hours' },
                    { label: 'days', value: 'days' }
                  ]}
                />
              </>
            ) : (
              <input
                type="time"
                className={styles.timeInput}
                value={time}
                onChange={(event) => setTime(event.target.value)}
              />
            )}
          </div>
          {recurrenceType === 'interval' && intervalUnit === 'minutes' && every < MIN_INTERVAL_MINUTES && (
            <p className={styles.hint}>Minimum {MIN_INTERVAL_MINUTES} minutes.</p>
          )}
          {recurrenceType === 'weekly' && (
            <div className={styles.weekdays}>
              {WEEKDAY_LABELS.map((label, day) => (
                <button
                  key={day}
                  type="button"
                  className={`${styles.weekday} ${weekdays.includes(day) ? styles.weekdaySelected : ''}`}
                  onClick={() => toggleWeekday(day)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className={styles.field}>
          <div className={styles.toolsHeader}>
            <span className={styles.label}>Tools this task can use unattended</span>
            <div className={styles.toolsActions}>
              <button type="button" className={styles.linkButton} onClick={selectAllTools}>
                Select all
              </button>
              <button type="button" className={styles.linkButton} onClick={clearAllTools}>
                Clear
              </button>
            </div>
          </div>
          {!hasProject && (
            <p className={styles.hint}>Select a project above to enable file and command tools.</p>
          )}
          <div className={styles.toolGroups}>
            {KIND_ORDER.map((kind) => {
              const toolsInKind = TOOL_CATALOG.filter((tool) => tool.kind === kind)
              if (toolsInKind.length === 0) return null
              return (
                <div key={kind} className={styles.toolGroup}>
                  <span className={styles.toolGroupLabel}>{KIND_LABELS[kind]}</span>
                  {KIND_RISK_NOTE[kind] && (
                    <p className={styles.riskNote}>{KIND_RISK_NOTE[kind]}</p>
                  )}
                  <div className={styles.toolList}>
                    {toolsInKind.map((tool) => {
                      const disabled = Boolean(tool.requiresProject) && !hasProject
                      return (
                        <label
                          key={tool.name}
                          className={`${styles.toolItem} ${disabled ? styles.toolItemDisabled : ''}`}
                          title={tool.description}
                        >
                          <input
                            type="checkbox"
                            checked={enabledTools.has(tool.name) && !disabled}
                            disabled={disabled}
                            onChange={() => toggleTool(tool.name)}
                          />
                          <code className={styles.toolName}>{tool.name}</code>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className={styles.footer}>
        {task && (
          <Button variant="danger" onClick={() => void handleDelete()}>
            Delete
          </Button>
        )}
        <div className={styles.footerRight}>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={!canSave} loading={saving}>
            {task ? 'Save' : 'Create task'}
          </Button>
        </div>
      </div>
    </Overlay>
  )
}
