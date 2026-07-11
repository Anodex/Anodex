import { useState } from 'react'
import {
  DEFAULT_MAX_TURNS,
  MAX_MAX_TURNS,
  DEFAULT_MAX_TOKENS,
  MAX_MAX_TOKENS,
  DEFAULT_MAX_DURATION_MINUTES,
  MAX_MAX_DURATION_MINUTES
} from '@shared/agentRun.types'
import { TOOL_CATALOG, type ToolKind } from '@shared/tools.types'
import { ANTHROPIC_MODELS, DEFAULT_ANTHROPIC_MODEL } from '@shared/anthropicModels'
import { OPENAI_MODELS, DEFAULT_OPENAI_MODEL } from '@shared/openaiModels'
import { useProjectStore } from '../../stores/projectStore'
import { useAgentStore } from '../../stores/agentStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { Overlay } from '../../components/ui/Overlay'
import { Button } from '../../components/ui/Button'
import { Icon } from '../../components/Icon'
import { SelectControl } from '../settings/controls'
import styles from './AgentRunEditor.module.css'

type RunProvider = 'local' | 'anthropic' | 'openai'

const KIND_ORDER: ToolKind[] = ['web', 'read', 'write', 'command', 'plan']
const KIND_LABELS: Record<ToolKind, string> = {
  web: 'Web',
  read: 'Read files',
  write: 'Edit files',
  command: 'Run commands',
  plan: 'Planning'
}
/** Shown under a risky group — there's no one present to click an approval prompt during a run. */
const KIND_RISK_NOTE: Partial<Record<ToolKind, string>> = {
  write: 'Runs automatically without asking, every turn.',
  command: 'Runs automatically without asking, every turn.'
}

/** Prefilled values when retrying/duplicating an existing run. */
export interface AgentRunEditorSeed {
  goal?: string
  projectId?: string | null
  provider?: RunProvider
  model?: string | null
  maxTurns?: number
  maxTokens?: number
  maxDurationMinutes?: number
  enabledTools?: string[]
}

interface AgentRunEditorProps {
  /** Prefilled values when retrying an existing run (its goal/settings, not its transcript). */
  seed?: AgentRunEditorSeed
  onClose: () => void
}

/** Create form for a new agent run: goal, project scope, per-tool access, and a turn budget. */
export function AgentRunEditor({ seed, onClose }: AgentRunEditorProps): JSX.Element {
  const projects = useProjectStore((s) => s.projects)
  const createRun = useAgentStore((s) => s.create)
  const settings = useSettingsStore((s) => s.settings)

  const anthropicKeySet = Boolean(settings?.provider.anthropic.apiKey.trim())
  const openaiKeySet = Boolean(settings?.provider.openai.apiKey.trim())
  const providerOptions = [
    { label: 'Local model', value: 'local' },
    ...(anthropicKeySet ? [{ label: 'Claude (Anthropic)', value: 'anthropic' }] : []),
    ...(openaiKeySet ? [{ label: 'ChatGPT / Codex (OpenAI)', value: 'openai' }] : [])
  ]

  const [goal, setGoal] = useState(seed?.goal ?? '')
  const [projectId, setProjectId] = useState<string | null>(seed?.projectId ?? null)
  const [provider, setProvider] = useState<RunProvider>(
    seed?.provider ?? settings?.provider.active ?? 'local'
  )
  const [model, setModel] = useState(() => {
    if (seed?.provider === 'anthropic') return seed.model ?? DEFAULT_ANTHROPIC_MODEL
    if (seed?.provider === 'openai') return seed.model ?? DEFAULT_OPENAI_MODEL
    if (seed) return ''
    if (settings?.provider.active === 'anthropic') {
      return settings.provider.anthropic.model.trim() || DEFAULT_ANTHROPIC_MODEL
    }
    if (settings?.provider.active === 'openai') {
      return settings.provider.openai.model.trim() || DEFAULT_OPENAI_MODEL
    }
    return ''
  })
  const [maxTurns, setMaxTurns] = useState(seed?.maxTurns ?? DEFAULT_MAX_TURNS)
  const [maxTokens, setMaxTokens] = useState(seed?.maxTokens ?? DEFAULT_MAX_TOKENS)
  const [maxDurationMinutes, setMaxDurationMinutes] = useState(
    seed?.maxDurationMinutes ?? DEFAULT_MAX_DURATION_MINUTES
  )
  const [enabledTools, setEnabledTools] = useState<Set<string>>(
    new Set(seed?.enabledTools ?? ['fetch_url', 'web_search'])
  )
  const [saving, setSaving] = useState(false)

  const hasProject = projectId !== null
  const availableTools = TOOL_CATALOG.filter((tool) => !tool.requiresProject || hasProject)
  const canSave =
    goal.trim().length > 0 && maxTurns >= 1 && maxTokens >= 1 && maxDurationMinutes >= 1

  const modelOptions =
    provider === 'anthropic'
      ? ANTHROPIC_MODELS.map((m) => ({ label: m.label, value: m.id }))
      : provider === 'openai'
        ? OPENAI_MODELS.map((m) => ({ label: m.label, value: m.id }))
        : []

  const handleProviderChange = (value: string): void => {
    const next = value as RunProvider
    setProvider(next)
    if (next === 'anthropic') {
      setModel(settings?.provider.anthropic.model.trim() || DEFAULT_ANTHROPIC_MODEL)
    } else if (next === 'openai') {
      setModel(settings?.provider.openai.model.trim() || DEFAULT_OPENAI_MODEL)
    }
  }

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
    await createRun({
      goal: goal.trim(),
      projectId,
      provider,
      model: provider === 'local' ? null : model,
      maxTurns,
      maxTokens,
      maxDurationMinutes,
      enabledTools: [...enabledTools].filter((toolName) =>
        availableTools.some((tool) => tool.name === toolName)
      )
    })
    setSaving(false)
    onClose()
  }

  return (
    <Overlay
      onClose={onClose}
      ariaLabel={seed ? 'Retry agent run' : 'New agent run'}
      cardClassName={styles.card}
    >
      <div className={styles.header}>
        <h2 className={styles.title}>{seed ? 'Retry agent run' : 'New agent run'}</h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close" title="Close">
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className={styles.body}>
        <label className={styles.field}>
          <span className={styles.label}>What should Anodex accomplish?</span>
          <textarea
            className={styles.textarea}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="e.g. Research what CONTRIBUTING.md says and summarize it."
            rows={3}
            autoFocus
          />
          <p className={styles.hint}>
            Runs unattended, checking in as it goes — no one will answer follow-up questions, so be
            specific.
          </p>
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

        <label className={styles.field}>
          <span className={styles.label}>Provider</span>
          <SelectControl value={provider} onChange={handleProviderChange} options={providerOptions} />
          <p className={styles.hint}>
            Independent of your global active model — picking one here never changes what
            interactive chat uses.
          </p>
        </label>

        {provider !== 'local' && (
          <label className={styles.field}>
            <span className={styles.label}>Model</span>
            <SelectControl value={model} onChange={setModel} options={modelOptions} />
          </label>
        )}

        <label className={styles.field}>
          <span className={styles.label}>Turn budget</span>
          <input
            type="number"
            min={1}
            max={MAX_MAX_TURNS}
            className={styles.turnsInput}
            value={maxTurns}
            onChange={(event) => setMaxTurns(Number(event.target.value) || 1)}
          />
          <p className={styles.hint}>
            Stops on its own after this many turns if it hasn&apos;t finished (max {MAX_MAX_TURNS}).
          </p>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Token budget</span>
          <input
            type="number"
            min={1}
            max={MAX_MAX_TOKENS}
            className={styles.turnsInput}
            value={maxTokens}
            onChange={(event) => setMaxTokens(Number(event.target.value) || 1)}
          />
          <p className={styles.hint}>
            Stops on its own once this many tokens have been used across every turn (max{' '}
            {MAX_MAX_TOKENS.toLocaleString()}).
          </p>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Time budget (minutes)</span>
          <input
            type="number"
            min={1}
            max={MAX_MAX_DURATION_MINUTES}
            className={styles.turnsInput}
            value={maxDurationMinutes}
            onChange={(event) => setMaxDurationMinutes(Number(event.target.value) || 1)}
          />
          <p className={styles.hint}>
            Stops on its own after this much wall-clock time (max {MAX_MAX_DURATION_MINUTES} minutes).
          </p>
        </label>

        <div className={styles.field}>
          <div className={styles.toolsHeader}>
            <span className={styles.label}>Tools this run can use</span>
            <div className={styles.toolsActions}>
              <button type="button" className={styles.linkButton} onClick={selectAllTools}>
                Select all
              </button>
              <button type="button" className={styles.linkButton} onClick={clearAllTools}>
                Clear
              </button>
            </div>
          </div>
          <p className={styles.hint}>
            Skill discovery (find_skill/load_skill) is always available, in addition to whatever you
            select here.
          </p>
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
                  {KIND_RISK_NOTE[kind] && <p className={styles.riskNote}>{KIND_RISK_NOTE[kind]}</p>}
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
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void handleSave()} disabled={!canSave} loading={saving}>
          Start run
        </Button>
      </div>
    </Overlay>
  )
}
