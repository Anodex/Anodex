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
import { SubAgentSettings } from './SubAgentSettings'
import { RangeControl, SelectControl, TextControl, ToggleControl } from '../../controls'
import { VisualPreviewStorage } from './VisualPreviewStorage'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import { WebSearchSetupDialog } from '../../../web-search/WebSearchSetupDialog'
import pageStyles from '../../SettingsPage.module.css'
import styles from './ToolsSkillsSettings.module.css'

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
  brave:
    'Needs a card on file; includes some free credit each month. Key at api-dashboard.search.brave.com.',
  tavily: 'Free plan, no card needed. Get a key at app.tavily.com.',
  google: 'Free tier: 100 queries/day. Requires an API key and Search Engine ID.'
}

export function ToolsSkillsSettings(): JSX.Element {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const [settingUpSearch, setSettingUpSearch] = useState(false)
  const mcpTools = useMcpStore((state) => state.tools)
  const [toolSearch, setToolSearch] = useState('')

  // Merges the static built-in catalog with whatever's actually discovered
  // from connected MCP servers right now, so this list reflects what's really
  // callable instead of silently omitting MCP tools (they're dynamic, so they
  // can never be part of the static TOOL_CATALOG array).
  const fullCatalog = useMemo<ToolCatalogEntry[]>(
    () => [
      ...TOOL_CATALOG,
      ...mcpTools.map((tool): ToolCatalogEntry => ({
        name: tool.qualifiedName,
        kind: 'mcp',
        description: `[${tool.serverName}] ${tool.description || tool.toolName}`
      }))
    ],
    [mcpTools]
  )

  if (!settings) return <></>

  const disabledToolNames = new Set(settings.tools.disabledTools)
  const disabledBuiltInCount = TOOL_CATALOG.filter((tool) =>
    disabledToolNames.has(tool.name)
  ).length
  const toolHealth = buildToolHealthSummary({
    catalog: TOOL_CATALOG,
    toolsEnabled: settings.tools.enabled,
    disabledToolCount: disabledBuiltInCount,
    workspaceRoot: settings.workspace.root,
    permissionMode: settings.general.permissionMode,
    webSearchProvider: settings.webSearch.provider
  })
  const toolAvailabilityDetails = buildToolAvailabilityDetails({
    workspaceRoot: settings.workspace.root,
    webSearchProvider: settings.webSearch.provider,
    emailAccountCount: settings.email.accounts.length,
    memoryCrossChatEnabled: settings.memory.crossChatEnabled,
    memoryPersonalEnabled: settings.memory.personalEnabled
  })
  const filteredTools = filterToolCatalog(fullCatalog, toolSearch)

  const setBuiltInToolEnabled = (name: string, enabled: boolean): void => {
    const next = new Set(settings.tools.disabledTools)
    if (enabled) next.delete(name)
    else next.add(name)
    void update({ tools: { disabledTools: [...next].sort() } })
  }

  return (
    <div className={pageStyles.page}>
      <header className={pageStyles.pageHeader}>
        <p className={pageStyles.pageKicker}>Assistant</p>
        <h1 className={pageStyles.pageTitle}>Tools</h1>
        <p className={pageStyles.pageDesc}>
          Choose available tools, terminal behavior, and web search providers. Set approvals in
          Autonomy.
        </p>
      </header>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Tool setup</h2>
        <SettingRow
          label="Default shell"
          description="Shell Anodex runs commands in. Leave empty for your system's own: PowerShell on Windows, your login shell on macOS and Linux."
          control={
            <TextControl
              value={settings.general.defaultShell}
              placeholder="System default"
              onChange={(value) => void update({ general: { defaultShell: value } })}
            />
          }
        />
        <SettingRow
          label="Desktop control"
          description="Separate opt-in for guarded Windows-only control. You must choose one visible application window, and every AI action still requires your approval."
          control={
            <ToggleControl
              checked={settings.computerControl.desktopControlEnabled}
              onChange={(value) =>
                void update({ computerControl: { desktopControlEnabled: value } })
              }
            />
          }
        />
      </section>

      <SubAgentSettings settings={settings} update={update} />

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Assistant tools</h2>
        <p className={pageStyles.sectionDesc}>
          Tools read and change files only inside an open project folder. Workspace access comes
          from the active project selected in the sidebar.
        </p>
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
            <span className={styles.summaryHint}>
              {TOOL_CATALOG.length - disabledBuiltInCount}/{TOOL_CATALOG.length} built-ins enabled
            </span>
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
                {tool.kind === 'mcp' ? (
                  <span className={styles.toolManaged}>server</span>
                ) : (
                  <ToggleControl
                    checked={!disabledToolNames.has(tool.name)}
                    ariaLabel={`${disabledToolNames.has(tool.name) ? 'Enable' : 'Disable'} ${tool.name}`}
                    onChange={(enabled) => setBuiltInToolEnabled(tool.name, enabled)}
                  />
                )}
              </div>
            ))}
          </div>
        </details>
      </section>

      <VisualPreviewStorage />

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Web search</h2>
        <p className={pageStyles.sectionDesc}>
          Choose the provider used by the assistant&apos;s web_search tool.
        </p>
        <div className={styles.searchSetup}>
          <Button
            variant={settings.webSearch.provider === 'none' ? 'primary' : 'secondary'}
            size="sm"
            iconLeft={<Icon name="web" size={14} />}
            onClick={() => setSettingUpSearch(true)}
          >
            {settings.webSearch.provider === 'none' ? 'Set up web search' : 'Change and test'}
          </Button>
        </div>
        {settingUpSearch && <WebSearchSetupDialog onClose={() => setSettingUpSearch(false)} />}
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
          </>
        )}
      </section>
    </div>
  )
}
