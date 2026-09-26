import { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { SettingRow } from '../../SettingRow'
import { RangeControl, SelectControl, ToggleControl } from '../../controls'
import pageStyles from '../../SettingsPage.module.css'

const PERMISSION_OPTIONS = [
  { label: 'Ask every time', value: 'ask' },
  { label: 'Edits: allow file edits and checks, ask commands', value: 'full' },
  { label: 'Untethered', value: 'untethered' }
]

const TURN_TIME_LIMIT_MAX_MINUTES = 120
const TURN_TIME_LIMIT_COMMIT_DELAY_MS = 250

function permissionHint(mode: 'ask' | 'full' | 'untethered'): string {
  if (mode === 'ask') return 'Prompt before writes and shell commands.'
  if (mode === 'full')
    return (
      'Edit files and run read-only checks (listing, reading, git status, node --check) ' +
      'without asking, once a turn has started. Still asks before any other command.'
    )
  return 'Allow safe and sensitive operations; destructive actions still require confirmation.'
}

function formatTurnTimeLimit(value: number): string {
  return value === 0 ? 'No limit' : `${value} min`
}

/** Persist a slider drag once rather than writing settings on every pointer movement. */
function TurnTimeLimitSlider({
  value,
  onCommit
}: {
  value: number | null
  onCommit: (minutes: number | null) => void
}): JSX.Element {
  const [local, setLocal] = useState(value ?? 0)
  const commitTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    setLocal(value ?? 0)
  }, [value])

  useEffect(() => () => clearTimeout(commitTimer.current), [])

  return (
    <RangeControl
      value={local}
      min={0}
      max={TURN_TIME_LIMIT_MAX_MINUTES}
      step={1}
      format={formatTurnTimeLimit}
      onChange={(next) => {
        setLocal(next)
        clearTimeout(commitTimer.current)
        commitTimer.current = setTimeout(
          () => onCommit(next === 0 ? null : next),
          TURN_TIME_LIMIT_COMMIT_DELAY_MS
        )
      }}
    />
  )
}

/** All settings that decide when Anodex asks, stops, or checks its own work. */
export function AutonomySettings(): JSX.Element {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)

  if (!settings) return <></>

  return (
    <div className={pageStyles.page}>
      <header className={pageStyles.pageHeader}>
        <p className={pageStyles.pageKicker}>Assistant</p>
        <h1 className={pageStyles.pageTitle}>Autonomy</h1>
        <p className={pageStyles.pageDesc}>
          Decide when Anodex can act on its own, when it asks, and how long a reply can work.
        </p>
      </header>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Action approvals</h2>
        <p className={pageStyles.sectionDesc}>
          These choices control approvals. Tool availability and provider setup are under Tools.
        </p>
        <SettingRow
          label="Permission mode"
          description={permissionHint(settings.general.permissionMode)}
          control={
            <SelectControl
              value={settings.general.permissionMode}
              options={PERMISSION_OPTIONS}
              onChange={(value) =>
                void update({
                  general: { permissionMode: value as typeof settings.general.permissionMode }
                })
              }
            />
          }
        />
        <SettingRow
          label="Approve web searches"
          description="Ask before each web search query when a provider is enabled in Tools."
          control={
            <ToggleControl
              checked={settings.webSearch.requireApproval}
              onChange={(value) => void update({ webSearch: { requireApproval: value } })}
            />
          }
        />
        <SettingRow
          label="Confirm destructive app actions"
          description="Confirm deletes and other destructive actions you start in the app. AI tool approvals follow Permission mode."
          control={
            <ToggleControl
              checked={settings.general.confirmDestructive}
              onChange={(value) => void update({ general: { confirmDestructive: value } })}
            />
          }
        />
      </section>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Work and review</h2>
        <SettingRow
          label="Per-turn time limit"
          description="Wall-clock cap on one reply, including tool calls. Applies to chat and agent turns. Scheduled tasks and Critical Thinking use separate budgets."
          control={
            <TurnTimeLimitSlider
              value={settings.generation.turnTimeLimitMinutes}
              onCommit={(minutes) => void update({ generation: { turnTimeLimitMinutes: minutes } })}
            />
          }
        />
        <SettingRow
          label="Check before finishing"
          description="When a project chat changes files, ask Anodex to check its work with a test, build, syntax check, or page review before replying."
          control={
            <ToggleControl
              checked={settings.tools.checkBeforeFinishing !== false}
              onChange={(value) => void update({ tools: { checkBeforeFinishing: value } })}
            />
          }
        />
      </section>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Workspace access</h2>
        <p className={pageStyles.sectionDesc}>
          File tools stay inside the active project. Choose a different project in the sidebar.
        </p>
        <SettingRow
          label="Active workspace"
          description={settings.workspace.root ?? 'No project open'}
          control={null}
        />
      </section>
    </div>
  )
}
