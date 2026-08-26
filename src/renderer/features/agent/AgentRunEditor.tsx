import { useState } from 'react'
import {
  DEFAULT_MAX_TURNS,
  MAX_MAX_TURNS,
  DEFAULT_MAX_TOKENS,
  MAX_MAX_TOKENS,
  DEFAULT_MAX_DURATION_MINUTES,
  MAX_MAX_DURATION_MINUTES
} from '@shared/agentRun.types'
import {
  buildRunToolNames,
  readOnlyRunToolNames,
  TOOL_CATALOG,
  type ToolKind
} from '@shared/tools.types'
import { ANTHROPIC_MODELS, DEFAULT_ANTHROPIC_MODEL } from '@shared/anthropicModels'
import { OPENAI_MODELS, DEFAULT_OPENAI_MODEL } from '@shared/openaiModels'
import { useLiveCloudModels } from '../../lib/useLiveCloudModels'
import { useProjectStore } from '../../stores/projectStore'
import { useAgentStore } from '../../stores/agentStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { notifyError } from '../../stores/uiStore'
import { anodex } from '../../lib/anodex'
import { Overlay } from '../../components/ui/Overlay'
import { Button } from '../../components/ui/Button'
import { Icon } from '../../components/Icon'
import { RangeControl, SelectControl, ToggleControl } from '../settings/controls'
import styles from './AgentRunEditor.module.css'

type RunProvider = 'local' | 'anthropic' | 'openai'

const KIND_ORDER: ToolKind[] = ['web', 'read', 'write', 'command', 'plan', 'mcp']
const KIND_LABELS: Record<ToolKind, string> = {
  web: 'Web',
  read: 'Read files',
  write: 'Edit files',
  command: 'Run commands',
  plan: 'Planning',
  mcp: 'MCP servers'
}
/** Shown under a risky group — there's no one present to click an approval prompt during a run. */
const KIND_RISK_NOTE: Partial<Record<ToolKind, string>> = {
  write: 'Runs automatically without asking, every turn.',
  command: 'Runs automatically without asking, every turn.'
}

/** Slider granularity for the two budgets whose ranges are too wide to step by 1. */
const TOKEN_STEP = 5_000
const DURATION_STEP = 5

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function formatTokens(value: number): string {
  return `${(value / 1000).toLocaleString()}k`
}

function formatDuration(value: number): string {
  if (value < 60) return `${value} min`
  const hours = Math.floor(value / 60)
  const minutes = value % 60
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes}`
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
  limitsEnabled?: boolean
  requirePlan?: boolean
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

  // Agent runs only support local/Anthropic/OpenAI today (see `RunProvider`) —
  // other globally-active providers (Grok, Kimi, etc.) fall back to Local
  // here rather than mis-typing the run's own provider field. Extending
  // Agent runs to the full provider set is a reasonable follow-up, not done
  // as part of wiring up those providers for interactive chat.
  const globalActiveAsRunProvider: RunProvider =
    settings?.provider.active === 'anthropic' || settings?.provider.active === 'openai'
      ? settings.provider.active
      : 'local'

  /**
   * Only a provider this install can actually authenticate as.
   *
   * A retry seed carries the provider of a run created months ago, and the key
   * behind it may have been removed since — leaving the select showing a value
   * absent from its own options, and `Start run` creating a run that fails on
   * its first turn. The same is true of the globally active provider, which the
   * Settings panel can leave selected after a key is cleared.
   */
  const usableProvider = (candidate: RunProvider | undefined): RunProvider | undefined =>
    candidate && providerOptions.some((option) => option.value === candidate)
      ? candidate
      : undefined

  const [goal, setGoal] = useState(seed?.goal ?? '')
  const [projectId, setProjectId] = useState<string | null>(seed?.projectId ?? null)
  const [provider, setProvider] = useState<RunProvider>(
    usableProvider(seed?.provider) ?? usableProvider(globalActiveAsRunProvider) ?? 'local'
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
  // Sliders can't represent a value below their own step, so a seed from an
  // older run typed into the number inputs (say 500 tokens) is pulled up to
  // the nearest position the track can actually show.
  const [maxTurns, setMaxTurns] = useState(
    clamp(seed?.maxTurns ?? DEFAULT_MAX_TURNS, 1, MAX_MAX_TURNS)
  )
  const [maxTokens, setMaxTokens] = useState(
    clamp(seed?.maxTokens ?? DEFAULT_MAX_TOKENS, TOKEN_STEP, MAX_MAX_TOKENS)
  )
  const [maxDurationMinutes, setMaxDurationMinutes] = useState(
    clamp(
      seed?.maxDurationMinutes ?? DEFAULT_MAX_DURATION_MINUTES,
      DURATION_STEP,
      MAX_MAX_DURATION_MINUTES
    )
  )
  const [limitsEnabled, setLimitsEnabled] = useState(seed?.limitsEnabled ?? true)
  const [requirePlan, setRequirePlan] = useState(seed?.requirePlan ?? true)
  // A new run starts able to build. See `buildRunToolNames` for why the old
  // default -- web access and nothing else -- made an unattended run useless.
  const [enabledTools, setEnabledTools] = useState<Set<string>>(
    new Set(seed?.enabledTools ?? buildRunToolNames())
  )
  const [saving, setSaving] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)

  const hasProject = projectId !== null
  // Gates "Select all" and the save filter, so a run can't be started carrying
  // a human-approval-only tool it could only ever be refused.
  const availableTools = TOOL_CATALOG.filter(
    (tool) => (!tool.requiresProject || hasProject) && !tool.requiresHumanApproval
  )
  const canSave =
    goal.trim().length > 0 &&
    (!limitsEnabled || (maxTurns >= 1 && maxTokens >= 1 && maxDurationMinutes >= 1))

  // Offered models come from what the key can actually reach — see
  // `useLiveCloudModels` for why a hardcoded list is not enough.
  const openAiOptions = useLiveCloudModels(provider, OPENAI_MODELS)
  const modelOptions =
    provider === 'anthropic'
      ? ANTHROPIC_MODELS.map((m) => ({ label: m.label, value: m.id }))
      : provider === 'openai'
        ? openAiOptions
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

  /**
   * Creates a project without switching the app's globally active project —
   * unlike `projectStore.create()` (which `Sidebar.tsx`'s own "New project"
   * button relies on `setActive` for), this editor already has its own
   * independent project selection and shouldn't have a side effect on
   * whatever the user has open in chat.
   */
  const handleCreateProject = async (): Promise<void> => {
    setCreatingProject(true)
    try {
      const result = await anodex.tools.pickFolder()
      if (!result.ok) {
        notifyError('Could not select folder', result.error.message)
        return
      }
      const folderPath = result.value
      if (!folderPath) return
      const name = folderPath.split(/[/\\]/).pop() ?? 'New project'
      const project = await anodex.projects.create({ name, folderPath })
      await useProjectStore.getState().load()
      setProjectId(project.id)
    } catch (error) {
      notifyError('Could not create project', error instanceof Error ? error.message : undefined)
    } finally {
      setCreatingProject(false)
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
    const run = await createRun({
      goal: goal.trim(),
      projectId,
      provider,
      model: provider === 'local' ? null : model,
      maxTurns,
      maxTokens,
      maxDurationMinutes,
      limitsEnabled,
      requirePlan,
      enabledTools: [...enabledTools].filter((toolName) =>
        availableTools.some((tool) => tool.name === toolName)
      )
    })
    setSaving(false)
    // Only on success. `agentStore.create` reports its own failure and returns
    // null, and this used to close regardless — so a refusal took the goal, the
    // budgets and every tool selection with it. The likeliest refusal is
    // "Another agent run is currently in progress", which is a matter of
    // waiting a moment, and the form the user had just filled in was gone.
    if (run) onClose()
  }

  return (
    <Overlay
      onClose={onClose}
      ariaLabel={seed ? 'Retry agent run' : 'New agent run'}
      cardClassName={styles.card}
    >
      <div className={styles.header}>
        <h2 className={styles.title}>{seed ? 'Retry agent run' : 'New agent run'}</h2>
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
          <div className={styles.projectRow}>
            <SelectControl
              value={projectId ?? ''}
              onChange={(value) => setProjectId(value || null)}
              options={[
                { label: 'No project (plain chat)', value: '' },
                ...projects.map((project) => ({ label: project.name, value: project.id }))
              ]}
            />
            <button
              type="button"
              className={styles.newProjectButton}
              onClick={() => void handleCreateProject()}
              disabled={creatingProject}
              aria-label="New project"
              title="New project"
            >
              <Icon name="folder-plus" size={14} />
            </button>
          </div>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Provider</span>
          <SelectControl
            value={provider}
            onChange={handleProviderChange}
            options={providerOptions}
          />
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

        <div className={styles.field}>
          <div className={styles.toggleRow}>
            <span className={styles.label}>Require plan review</span>
            <ToggleControl checked={requirePlan} onChange={setRequirePlan} />
          </div>
          <p className={styles.hint}>
            {requirePlan
              ? 'Anodex proposes a plan first and pauses for your approval before doing anything ' +
                'else. Turn off to let it start working immediately.'
              : 'Starts working immediately, with no plan review checkpoint.'}
          </p>
        </div>

        <div className={styles.field}>
          <div className={styles.toggleRow}>
            <span className={styles.label}>Enforce limits</span>
            <ToggleControl checked={limitsEnabled} onChange={setLimitsEnabled} />
          </div>
          <p className={styles.hint}>
            {limitsEnabled
              ? 'Stops on its own once one of the budgets below is reached.'
              : 'No limits — runs until it finishes on its own or you stop it manually. It still ' +
                'checks in periodically so you can see what it’s doing.'}
          </p>
          {!limitsEnabled && provider !== 'local' && (
            <p className={styles.riskNote}>
              This run uses {provider === 'anthropic' ? 'Claude' : 'OpenAI'}, a paid API, with no
              limits — it could run for a long time and use a meaningful number of paid tokens
              before finishing or being stopped.
            </p>
          )}
        </div>

        {limitsEnabled && (
          <>
            <div className={styles.field}>
              <span className={styles.label}>Turn budget</span>
              <RangeControl
                value={maxTurns}
                min={1}
                max={MAX_MAX_TURNS}
                step={1}
                onChange={setMaxTurns}
                format={(value) => `${value} turns`}
              />
              <p className={styles.hint}>
                Stops on its own after this many turns if it hasn&apos;t finished (max{' '}
                {MAX_MAX_TURNS}).
              </p>
            </div>

            <div className={styles.field}>
              <span className={styles.label}>Token budget</span>
              <RangeControl
                value={maxTokens}
                min={TOKEN_STEP}
                max={MAX_MAX_TOKENS}
                step={TOKEN_STEP}
                onChange={setMaxTokens}
                format={formatTokens}
              />
              <p className={styles.hint}>
                Stops on its own once this many tokens have been used across every turn (max{' '}
                {MAX_MAX_TOKENS.toLocaleString()}).
              </p>
            </div>

            <div className={styles.field}>
              <span className={styles.label}>Time budget</span>
              <RangeControl
                value={maxDurationMinutes}
                min={DURATION_STEP}
                max={MAX_MAX_DURATION_MINUTES}
                step={DURATION_STEP}
                onChange={setMaxDurationMinutes}
                format={formatDuration}
              />
              <p className={styles.hint}>
                Stops on its own after this much time spent working (max {MAX_MAX_DURATION_MINUTES}{' '}
                minutes). Waiting for you to approve its plan does not count against it.
              </p>
            </div>
          </>
        )}

        <div className={styles.field}>
          <div className={styles.toolsHeader}>
            <span className={styles.label}>Tools this run can use</span>
            <div className={styles.toolsActions}>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => setEnabledTools(new Set(buildRunToolNames()))}
              >
                Build
              </button>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => setEnabledTools(new Set(readOnlyRunToolNames()))}
              >
                Read only
              </button>
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
                  {KIND_RISK_NOTE[kind] && (
                    <p className={styles.riskNote}>{KIND_RISK_NOTE[kind]}</p>
                  )}
                  <div className={styles.toolList}>
                    {toolsInKind.map((tool) => {
                      // An agent run is unattended, so tools needing a live
                      // approval are shown disabled rather than hidden —
                      // ticking one would only ever be refused mid-run.
                      const disabled =
                        (Boolean(tool.requiresProject) && !hasProject) ||
                        Boolean(tool.requiresHumanApproval)
                      return (
                        <label
                          key={tool.name}
                          className={`${styles.toolItem} ${disabled ? styles.toolItemDisabled : ''}`}
                          title={
                            tool.requiresHumanApproval
                              ? `${tool.description} Unavailable in agent runs: it needs a person to approve each action.`
                              : tool.description
                          }
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
        <Button
          variant="primary"
          onClick={() => void handleSave()}
          disabled={!canSave}
          loading={saving}
        >
          Start run
        </Button>
      </div>
    </Overlay>
  )
}
