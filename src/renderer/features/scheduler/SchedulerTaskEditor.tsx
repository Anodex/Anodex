import { useState } from 'react'
import type { ScheduledTask, TaskRecurrence } from '@shared/scheduledTask.types'
import { describeRecurrence } from '@shared/parseWhen'
import { TOOL_CATALOG, type ToolKind } from '@shared/tools.types'
import { useProjectStore } from '../../stores/projectStore'
import { useSchedulerStore } from '../../stores/schedulerStore'
import { Overlay } from '../../components/ui/Overlay'
import { Button } from '../../components/ui/Button'
import { Icon } from '../../components/Icon'
import { SelectControl } from '../settings/controls'
import { WhenField } from './WhenField'
import styles from './SchedulerTaskEditor.module.css'

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
  const [recurrence, setRecurrence] = useState<TaskRecurrence>(initialRecurrence)
  // Seeded from the schedule's own description so an existing task opens with
  // the field already reading back what it's set to, not blank.
  const [whenText, setWhenText] = useState(() => describeRecurrence(initialRecurrence))
  const [enabledTools, setEnabledTools] = useState<Set<string>>(
    new Set(task?.enabledTools ?? seed?.enabledTools ?? ['fetch_url', 'web_search'])
  )
  const [saving, setSaving] = useState(false)

  const hasProject = projectId !== null
  const availableTools = TOOL_CATALOG.filter((tool) => !tool.requiresProject || hasProject)
  const canSave =
    prompt.trim().length > 0 &&
    (recurrence.type !== 'weekly' || (recurrence.weekdays ?? []).length > 0)

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

  const handleSave = async (): Promise<void> => {
    if (!canSave || saving) return
    setSaving(true)

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
    <Overlay
      onClose={onClose}
      ariaLabel={task ? 'Edit scheduled task' : 'New scheduled task'}
      cardClassName={styles.card}
    >
      <div className={styles.header}>
        <h2 className={styles.title}>{task ? 'Edit task' : 'New scheduled task'}</h2>
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

        <WhenField
          value={recurrence}
          onChange={setRecurrence}
          text={whenText}
          onTextChange={setWhenText}
        />

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
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={!canSave}
            loading={saving}
          >
            {task ? 'Save' : 'Create task'}
          </Button>
        </div>
      </div>
    </Overlay>
  )
}
