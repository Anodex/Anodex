import { useState, type ReactNode } from 'react'
import type { AppSettings, DeepPartial } from '@shared/settings.types'
import { TOOL_CATALOG } from '@shared/tools.types'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUiStore } from '../../stores/uiStore'
import { PageHeader } from '../../components/PageHeader'
import { Icon } from '../../components/Icon'
import { Spinner } from '../../components/ui/Spinner'
import { SettingRow } from './SettingRow'
import { RangeControl, SelectControl, TextControl, ToggleControl } from './controls'
import { ProfileSettings } from './pages/profile/ProfileSettings'
import { AppearanceSettings } from './pages/appearance/AppearanceSettings'
import { GeneralSettings } from './pages/general/GeneralSettings'
import { AiModelsSettings } from './pages/ai-models/AiModelsSettings'
import { DiagnosticsSettings } from './pages/diagnostics/DiagnosticsSettings'
import { AboutSettings } from './pages/about/AboutSettings'
import { ProjectsSettings } from './pages/projects/ProjectsSettings'
import styles from './SettingsView.module.css'

type SettingsSection =
  'profile' | 'appearance' | 'general' | 'projects' | 'ai-models' | 'diagnostics' | 'about'

interface NavItem {
  id: SettingsSection
  label: string
  icon: ReactNode
}

const NAV: NavItem[] = [
  { id: 'profile', label: 'Profile', icon: <Icon name="user" size={18} /> },
  { id: 'appearance', label: 'Appearance', icon: <Icon name="palette" size={18} /> },
  { id: 'general', label: 'General', icon: <Icon name="sliders" size={18} /> },
  { id: 'projects', label: 'Projects', icon: <Icon name="folder" size={18} /> },
  { id: 'ai-models', label: 'AI & Models', icon: <Icon name="cpu" size={18} /> },
  { id: 'diagnostics', label: 'Diagnostics', icon: <Icon name="activity" size={18} /> },
  { id: 'about', label: 'About', icon: <Icon name="info" size={18} /> }
]

const WEB_SEARCH_OPTIONS = [
  { label: 'Disabled', value: 'none' },
  { label: 'SearXNG (self-hosted)', value: 'searxng' },
  { label: 'Brave Search', value: 'brave' },
  { label: 'Tavily', value: 'tavily' },
  { label: 'Google Programmable Search', value: 'google' }
]

const PROVIDER_HINTS: Record<string, string> = {
  none: 'Web search is disabled.',
  searxng:
    'Run your own SearXNG instance (e.g. docker compose -f docker-compose.searxng.yml up -d). No API key needed.',
  brave: 'Free tier: 2,000 queries/month. Get a key at api.search.brave.com.',
  tavily: 'Free tier: 1,000 API calls/month. Get a key at tavily.com.',
  google: 'Free tier: 100 queries/day. Requires an API key and a Search Engine ID.'
}

/** Full settings area with a left-hand section navigation. */
export function SettingsView(): JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const setView = useUiStore((s) => s.setView)

  const [section, setSection] = useState<SettingsSection>('profile')

  if (!settings) {
    return (
      <>
        <PageHeader title="Settings" />
        <div className={styles.loading}>
          <Spinner size={20} />
        </div>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Configure Anodex, your profile, and the local engine"
      />

      <div className={styles.layout}>
        <nav className={styles.sidebar} aria-label="Settings sections">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`${styles.navItem} ${section === item.id ? styles.navItemActive : ''}`}
              onClick={() => setSection(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
          <div className={styles.sidebarFooter}>
            <button type="button" className={styles.backButton} onClick={() => setView('chat')}>
              <Icon name="close" size={16} />
              Close settings
            </button>
          </div>
        </nav>

        <div className={styles.content}>
          <div className={styles.scroll}>
            <div className={styles.inner}>
              {section === 'profile' && (
                <ProfileSettings
                  settings={settings}
                  update={(patch) => void update({ profile: patch })}
                />
              )}
              {section === 'appearance' && (
                <AppearanceSettings
                  settings={settings}
                  update={(patch) => void update({ appearance: patch })}
                />
              )}
              {section === 'general' && (
                <GeneralSettings
                  settings={settings}
                  update={(patch) => void update({ general: patch })}
                />
              )}
              {section === 'ai-models' && <AiModelsSettings />}
              {section === 'diagnostics' && (
                <DiagnosticsSettings
                  settings={settings}
                  update={(patch) => void update({ diagnostics: patch })}
                />
              )}
              {section === 'about' && <AboutSettings />}
              {section === 'projects' && <ProjectsSettings />}
              {section === 'general' && <GeneralToolsSection settings={settings} update={update} />}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

interface GeneralToolsSectionProps {
  settings: AppSettings
  update: (patch: DeepPartial<AppSettings>) => Promise<void>
}

function GeneralToolsSection({ settings, update }: GeneralToolsSectionProps): JSX.Element {
  const engine = useModelStore((s) => s.engine)
  // The setting is a target; the engine can resolve a smaller *actual*
  // context for a given model + hardware combination (heavier model sizes on
  // borderline hardware are the common case — see `contextWasDownsized` in
  // AiModelsSettings.tsx). Once a model is loaded, cap against what's really
  // running, not just the aspirational setting, so this can't let a reply
  // budget be set larger than the context that's actually available to fit it in.
  const effectiveContextSize =
    engine.status === 'ready' && engine.contextSize ? engine.contextSize : settings.model.contextSize

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>Assistant tools</h2>
      <p className={styles.sectionDesc}>
        Let the assistant read and edit files within an open project&apos;s folder. There&apos;s no
        standalone workspace setting — link or open a project in Settings → Projects to give the
        assistant file access; a plain chat can only read and discuss code, never edit it.
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
      <p className={styles.toolListHint}>
        How much confirmation each tool needs is controlled by the permission mode in Settings →
        General → Permissions. File and command tools all require an open project — a plain chat
        with no project can still discuss code, but can&apos;t read or change files.
      </p>
      <div className={styles.toolList}>
        {TOOL_CATALOG.map((tool) => (
          <div key={tool.name} className={styles.toolItem}>
            <code className={styles.toolName}>{tool.name}</code>
            <span className={`${styles.toolKind} ${styles[tool.kind]}`}>{tool.kind}</span>
            <span className={styles.toolDesc}>{tool.description}</span>
          </div>
        ))}
      </div>

      <h2 className={styles.sectionTitle} style={{ marginTop: 'var(--space-6)' }}>
        Web Search
      </h2>
      <p className={styles.sectionDesc}>
        Choose a search provider for the assistant&apos;s web_search tool. Free tiers are available
        for every provider.
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
          description="Your provider API key. Stored locally in settings."
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
          description="Google Custom Search Engine ID (cx)."
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
            description="Number of results per query."
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

      <h2 className={styles.sectionTitle} style={{ marginTop: 'var(--space-6)' }}>
        Generation
      </h2>
      <SettingRow
        label="Temperature"
        description="Higher is more creative, lower is more focused."
        control={
          <RangeControl
            value={settings.generation.temperature}
            min={0}
            max={1.5}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(value) => void update({ generation: { temperature: value } })}
          />
        }
      />
      <SettingRow
        label="Top-p"
        description="Nucleus sampling cutoff."
        control={
          <RangeControl
            value={settings.generation.topP}
            min={0}
            max={1}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(value) => void update({ generation: { topP: value } })}
          />
        }
      />
      <SettingRow
        label="Max response tokens"
        description="Upper bound on the length of each reply. Capped by the actual running context size, since a reply can't outgrow the context it has to fit in."
        control={
          <RangeControl
            // Clamp what's displayed/draggable, not just the ceiling: a
            // context that shrinks (either the setting being lowered, or the
            // engine resolving a smaller real context than requested) could
            // otherwise leave a stored value the slider can no longer
            // represent, silently clamped by the browser instead of by us.
            // See the context-size and GPU-layers fixes this session for the
            // same root cause.
            value={Math.min(settings.generation.maxTokens, effectiveContextSize)}
            min={128}
            max={effectiveContextSize}
            step={128}
            onChange={(value) => void update({ generation: { maxTokens: value } })}
          />
        }
      />

      <h2 className={styles.sectionTitle} style={{ marginTop: 'var(--space-6)' }}>
        Assistant
      </h2>
      <p className={styles.sectionDesc}>
        The system prompt sets the assistant&apos;s behaviour for every new conversation.
      </p>
      <textarea
        className={styles.textarea}
        value={settings.ui.systemPrompt}
        rows={4}
        onChange={(event) => void update({ ui: { systemPrompt: event.target.value } })}
      />
    </section>
  )
}
