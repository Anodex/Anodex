import type { ReactNode } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUiStore, type SettingsSection } from '../../stores/uiStore'
import { PageHeader } from '../../components/PageHeader'
import { Icon } from '../../components/Icon'
import { Spinner } from '../../components/ui/Spinner'
import { ProfileSettings } from './pages/profile/ProfileSettings'
import { AppearanceSettings } from './pages/appearance/AppearanceSettings'
import { GeneralSettings } from './pages/general/GeneralSettings'
import { AiModelsSettings } from './pages/ai-models/AiModelsSettings'
import { DiagnosticsSettings } from './pages/diagnostics/DiagnosticsSettings'
import { AboutSettings } from './pages/about/AboutSettings'
import { ProjectsSettings } from './pages/projects/ProjectsSettings'
import { MemorySettings } from './pages/memory/MemorySettings'
import { EmailSettings } from './pages/email/EmailSettings'
import { ArchiveSettings } from './pages/archive/ArchiveSettings'
import { ToolsSkillsSettings } from './pages/tools-skills/ToolsSkillsSettings'
import styles from './SettingsView.module.css'

interface NavItem {
  id: SettingsSection
  label: string
  icon: ReactNode
}

interface NavGroup {
  label: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Personal',
    items: [
      { id: 'profile', label: 'Profile', icon: <Icon name="user" size={18} /> },
      { id: 'appearance', label: 'Appearance', icon: <Icon name="palette" size={18} /> },
      { id: 'memory', label: 'Memory', icon: <Icon name="layers" size={18} /> }
    ]
  },
  {
    label: 'Workspace',
    items: [
      { id: 'general', label: 'General', icon: <Icon name="sliders" size={18} /> },
      { id: 'tools-skills', label: 'Tools & Skills', icon: <Icon name="sliders" size={18} /> }
    ]
  },
  {
    label: 'Connections',
    items: [
      { id: 'ai-models', label: 'AI & Models', icon: <Icon name="cpu" size={18} /> },
      { id: 'email', label: 'Email', icon: <Icon name="mail" size={18} /> }
    ]
  },
  {
    label: 'System',
    items: [
      { id: 'archive', label: 'Archive', icon: <Icon name="archive" size={18} /> },
      { id: 'diagnostics', label: 'Diagnostics', icon: <Icon name="activity" size={18} /> },
      { id: 'about', label: 'About', icon: <Icon name="info" size={18} /> }
    ]
  }
]

/** Full settings area with grouped left-hand section navigation. */
export function SettingsView(): JSX.Element {
  const settings = useSettingsStore((state) => state.settings)
  const update = useSettingsStore((state) => state.update)
  const setView = useUiStore((state) => state.setView)
  const section = useUiStore((state) => state.settingsSection)
  const setSection = useUiStore((state) => state.setSettingsSection)

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
      <PageHeader title="Settings" subtitle="Configure Anodex and the local engine" />

      <div className={styles.layout}>
        <nav className={styles.sidebar} aria-label="Settings sections">
          <div className={styles.navScroll}>
            {NAV_GROUPS.map((group) => (
              <div key={group.label} className={styles.navGroup}>
                <div className={styles.navGroupLabel}>{group.label}</div>
                {group.items.map((item) => (
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
              </div>
            ))}
          </div>
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
              {section === 'profile' && <ProfileSettings settings={settings} update={update} />}
              {section === 'appearance' && (
                <AppearanceSettings
                  settings={settings}
                  update={(patch) => void update({ appearance: patch })}
                />
              )}
              {section === 'memory' && <MemorySettings />}
              {section === 'general' && (
                <GeneralSettings
                  settings={settings}
                  update={(patch) => void update({ general: patch })}
                />
              )}
              {section === 'projects' && <ProjectsSettings />}
              {section === 'tools-skills' && <ToolsSkillsSettings />}
              {section === 'ai-models' && <AiModelsSettings />}
              {section === 'email' && <EmailSettings />}
              {section === 'archive' && <ArchiveSettings />}
              {section === 'diagnostics' && (
                <DiagnosticsSettings
                  settings={settings}
                  update={(patch) => void update({ diagnostics: patch })}
                />
              )}
              {section === 'about' && <AboutSettings />}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
