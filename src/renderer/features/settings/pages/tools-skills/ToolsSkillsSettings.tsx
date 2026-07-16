import { useMemo, useState } from 'react'
import { TOOL_CATALOG, type ToolCatalogEntry } from '@shared/tools.types'
import {
  buildToolAvailabilityDetails,
  buildToolHealthSummary,
  filterToolCatalog,
  type ToolHealthTone
} from '../../../../lib/toolHealth'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { useMcpStore } from '../../../../stores/mcpStore'
import { StatusDot, type StatusTone } from '../../../../components/ui/StatusDot'
import { SettingRow } from '../../SettingRow'
import { RangeControl, SelectControl, TextControl, ToggleControl } from '../../controls'
import { PersonalSkillsSection } from './PersonalSkillsSection'
import pageStyles from '../../SettingsPage.module.css'
import styles from './ToolsSkillsSettings.module.css'

const PERMISSION_OPTIONS = [
  { label: 'Ask every time', value: 'ask' },
  { label: 'Allow writes, ask commands', value: 'full' },
  { label: 'Untethered', value: 'untethered' }
]

const WEB_SEARCH_OPTIONS = [
  { label: 'Disabled', value: 'none' },
  { label: 'SearXNG (self-hosted)', value: 'searxng' },
  { label: 'Brave Search', value: 'brave' },
  { label: 'Tavily', value: 'tavily' },
  { label: 'Google Programmable Search', value: 'google' }
]

const TOOL_HEALTH_STATUS_TONE: Record<ToolHealthTone, StatusTone> = {
  ready: 'success',
  attention: 'warning',
  blocked: 'danger',
  muted: 'neutral'
}

const PROVIDER_HINTS: Record<string, string> = {
  none: 'Web search is disabled.',
  searxng: 'Run your own SearXNG instance. No API key is needed.',
  brave: 'Free tier: 2,000 queries/month. Get a key at api.search.brave.com.',
  tavily: 'Free tier: 1,000 API calls/month. Get a key at tavily.com.',
  google: 'Free tier: 100 queries/day. Requires an API key and Search Engine ID.'
}

export function ToolsSkillsSettings(): JSX.Element {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const mcpTools = useMcpStore((state) => state.tools)
  const [toolSearch, setToolSearch] = useState('')

  // Merges the static built-in catalog with whatever's actually discovered
  // from connected MCP servers right now, so this list reflects what's really
  // callable instead of silently omitting MCP tools (they're dynamic, so they
  // can never be part of the static TOOL_CATALOG array).
  const fullCatalog = useMemo<ToolCatalogEntry[]>(
    () => [
      ...TOOL_CATALOG,
      ...mcpTools.map(
        (tool): ToolCatalogEntry => ({
          name: tool.qualifiedName,
          kind: 'mcp',
          description: `[${tool.serverName}] ${tool.description || tool.toolName}`
        })
      )
    ],
    [mcpTools]
  )

  if (!settings) return <></>

  const toolHealth = buildToolHealthSummary({
    catalog: TOOL_CATALOG,
    toolsEnabled: settings.tools.enabled,
    workspaceRoot: settings.workspace.root,
    permissionMode: settings.general.permissionMode,
    webSearchProvider: settings.webSearch.provider
  })
  const toolAvailabilityDetails = buildToolAvailabilityDetails({
    workspaceRoot: settings.workspace.root,
    webSearchProvider: settings.webSearch.provider,
    emailProvider: settings.email.provider,
    gmailEnabled: settings.email.gmail.enabled,
    memoryCrossChatEnabled: settings.memory.crossChatEnabled,
    memoryPersonalEnabled: settings.memory.personalEnabled
  })
  const filteredTools = filterToolCatalog(fullCatalog, toolSearch)

  return (
    <div className={pageStyles.page}>
      <header className={pageStyles.pageHeader}>
        <p className={pageStyles.pageKicker}>Workspace</p>
        <h1 className={pageStyles.pageTitle}>Tools & Skills</h1>
        <p className={pageStyles.pageDesc}>
          Control assistant access, reusable personal workflows, terminal behavior, and web search.
        </p>
      </header>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Permissions</h2>
        <p className={pageStyles.sectionDesc}>How much autonomy tools have over your machine.</p>
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
          label="Confirm destructive actions"
          description="Show a confirmation before delete, overwrite, reset, or destructive tool operations."
          control={
            <ToggleControl
              checked={settings.general.confirmDestructive}
              onChange={(value) => void update({ general: { confirmDestructive: value } })}
            />
          }
        />
        <SettingRow
          label="Default shell"
          description="Shell used by the run_command tool."
          control={
            <TextControl
              value={settings.general.defaultShell}
              placeholder="powershell"
              onChange={(value) => void update({ general: { defaultShell: value } })}
            />
          }
        />
      </section>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Assistant tools</h2>
        <p className={pageStyles.sectionDesc}>
          Tools read and change files only inside an open project folder. Workspace access comes
          from the active project selected in the sidebar.
        </p>
        <SettingRow
          label="Active workspace"
          description={settings.workspace.root ?? 'No project open'}
          control={null}
        />
        <SettingRow
          label="Enable tools"
          description="Master switch for all assistant tools."
          control={
            <ToggleControl
              checked={settings.tools.enabled}
              onChange={(value) => void update({ tools: { enabled: value } })}
            />
          }
        />

        <div className={styles.toolHealthGrid}>
          {toolHealth.map((item) => (
            <div key={item.label} className={`${styles.toolHealthCard} ${styles[item.tone]}`}>
              <span className={styles.toolHealthLabel}>{item.label}</span>
              <span className={styles.toolHealthValue}>
                <StatusDot
                  tone={TOOL_HEALTH_STATUS_TONE[item.tone]}
                  className={styles.toolHealthDot}
                />
                {item.value}
              </span>
            </div>
          ))}
        </div>

        <details className={styles.disclosure}>
          <summary className={styles.summary}>
            <span>Availability details</span>
            <span className={styles.summaryHint}>Why tools may be hidden</span>
          </summary>
          <div className={styles.availabilityList}>
            {toolAvailabilityDetails.map((item) => (
              <div key={item.label} className={styles.availabilityItem}>
                <span className={styles.availabilityLabel}>
                  <StatusDot
                    tone={TOOL_HEALTH_STATUS_TONE[item.tone]}
                    className={styles.toolHealthDot}
                  />
                  {item.label}
                </span>
                <span className={styles.availabilityValue}>{item.value}</span>
              </div>
            ))}
          </div>
        </details>

        <details className={styles.disclosure}>
          <summary className={styles.summary}>
            <span>Tool catalog</span>
            <span className={styles.summaryHint}>{fullCatalog.length} tools</span>
          </summary>
          <input
            className={styles.catalogSearch}
            value={toolSearch}
            placeholder="Filter tools by name, kind, or project requirement"
            onChange={(event) => setToolSearch(event.target.value)}
          />
          <div className={styles.toolList}>
            {filteredTools.length === 0 && (
              <p className={styles.toolEmpty}>No tools match “{toolSearch.trim()}”.</p>
            )}
            {filteredTools.map((tool) => (
              <div key={tool.name} className={styles.toolItem}>
                <code className={styles.toolName}>{tool.name}</code>
                <span className={`${styles.toolKind} ${styles[tool.kind]}`}>{tool.kind}</span>
                <span className={styles.toolDesc}>{tool.description}</span>
              </div>
            ))}
          </div>
        </details>
      </section>

      <PersonalSkillsSection />

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Web search</h2>
        <p className={pageStyles.sectionDesc}>
          Choose the provider used by the assistant&apos;s web_search tool.
        </p>
        <SettingRow
          label="Provider"
          description={PROVIDER_HINTS[settings.webSearch.provider]}
          control={
            <SelectControl
              value={settings.webSearch.provider}
              options={WEB_SEARCH_OPTIONS}
              onChange={(value) =>
                void update({
                  webSearch: { provider: value as typeof settings.webSearch.provider }
                })
              }
            />
          }
        />
        {settings.webSearch.provider === 'searxng' && (
          <SettingRow
            label="SearXNG base URL"
            description="URL of your local SearXNG instance."
            control={
              <TextControl
                value={settings.webSearch.baseUrl}
                placeholder="http://localhost:8080"
                onChange={(value) => void update({ webSearch: { baseUrl: value } })}
              />
            }
          />
        )}
        {(settings.webSearch.provider === 'brave' ||
          settings.webSearch.provider === 'tavily' ||
          settings.webSearch.provider === 'google') && (
          <SettingRow
            label="API key"
            description="Stored locally using the operating system credential store."
            control={
              <TextControl
                type="password"
                value={settings.webSearch.apiKey}
                placeholder="Paste API key"
                onChange={(value) => void update({ webSearch: { apiKey: value } })}
              />
            }
          />
        )}
        {settings.webSearch.provider === 'google' && (
          <SettingRow
            label="Search Engine ID"
            description="Google Programmable Search Engine ID (cx)."
            control={
              <TextControl
                value={settings.webSearch.searchEngineId}
                placeholder="Paste Search Engine ID"
                onChange={(value) => void update({ webSearch: { searchEngineId: value } })}
              />
            }
          />
        )}
        {settings.webSearch.provider !== 'none' && (
          <>
            <SettingRow
              label="Result count"
              description="Number of results requested per query."
              control={
                <RangeControl
                  value={settings.webSearch.resultCount}
                  min={1}
                  max={10}
                  step={1}
                  onChange={(value) => void update({ webSearch: { resultCount: value } })}
                />
              }
            />
            <SettingRow
              label="Require approval"
              description="Ask before each web search query."
              control={
                <ToggleControl
                  checked={settings.webSearch.requireApproval}
                  onChange={(value) => void update({ webSearch: { requireApproval: value } })}
                />
              }
            />
          </>
        )}
      </section>
    </div>
  )
}

function permissionHint(mode: 'ask' | 'full' | 'untethered'): string {
  if (mode === 'ask') return 'Prompt before writes and shell commands.'
  if (mode === 'full') return 'Allow file edits; still ask before sensitive commands.'
  return 'Allow safe and sensitive operations; destructive actions still require confirmation.'
}
