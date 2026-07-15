import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useProjectStore } from '../../stores/projectStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUiStore } from '../../stores/uiStore'
import { useSidebarCollapse } from '../../stores/sidebarCollapseStore'
import { useCreateProject } from '../../hooks/useCreateProject'
import { isChatReady } from '../../lib/chatReadiness'
import { Icon } from '../Icon'
import { StatusDot } from '../ui/StatusDot'
import styles from './SidebarRail.module.css'

/** Icon-only sidebar for narrow windows. Global nav still navigates directly;
 *  anything that needs the project/chat list opens the full sidebar as a
 *  temporary overlay instead of permanently squeezing the chat area. */
export function SidebarRail(): JSX.Element {
  const view = useUiStore((s) => s.view)
  const setView = useUiStore((s) => s.setView)
  const openSettings = useUiStore((s) => s.openSettings)
  const newConversation = useChatStore((s) => s.newConversation)
  const setActiveProject = useProjectStore((s) => s.setActive)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const projects = useProjectStore((s) => s.projects)
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null
  const settings = useSettingsStore((s) => s.settings)
  const engineStatus = useModelStore((s) => s.engine.status)
  const ready = isChatReady(settings, engineStatus)
  const expandSidebar = useSidebarCollapse((s) => s.expand)
  const handleCreateProject = useCreateProject()

  const handleNewChat = (): void => {
    void setActiveProject(null)
    newConversation(null)
    setView('chat')
  }

  return (
    <div className={styles.rail}>
      <button
        type="button"
        className={`${styles.railButton} ${view === 'scheduler' ? styles.railButtonActive : ''}`}
        onClick={() => setView('scheduler')}
        aria-label="Scheduler"
        title="Scheduler"
      >
        <Icon name="clock" size={16} />
      </button>
      <button
        type="button"
        className={`${styles.railButton} ${view === 'agent' ? styles.railButtonActive : ''}`}
        onClick={() => setView('agent')}
        aria-label="Agent"
        title="Agent"
      >
        <Icon name="wand" size={16} />
      </button>
      <button
        type="button"
        className={`${styles.railButton} ${view === 'critical-thinking' ? styles.railButtonActive : ''}`}
        onClick={() => setView('critical-thinking')}
        aria-label="Critical Thinking"
        title="Critical Thinking"
      >
        <Icon name="globe" size={16} />
      </button>
      <button
        type="button"
        className={`${styles.railButton} ${view === 'email' ? styles.railButtonActive : ''}`}
        onClick={() => setView('email')}
        aria-label="Email"
        title="Email"
      >
        <Icon name="mail" size={16} />
      </button>

      {activeProject && (
        <button
          type="button"
          className={styles.railButton}
          onClick={expandSidebar}
          aria-label={`Current project: ${activeProject.name}`}
          title={activeProject.name}
        >
          <Icon name="folder" size={16} />
        </button>
      )}

      <div className={styles.railSpacer} />

      <button
        type="button"
        className={styles.railButton}
        onClick={() => void handleCreateProject()}
        aria-label="New project"
        title="New project"
      >
        <Icon name="folder-plus" size={16} />
      </button>

      <button
        type="button"
        className={styles.railButton}
        onClick={handleNewChat}
        aria-label="New chat"
        title="New chat"
      >
        <Icon name="plus" size={16} />
      </button>

      <button
        type="button"
        className={styles.railButton}
        onClick={() => openSettings('ai-models')}
        aria-label="Model status"
        title={ready ? 'Model ready' : 'No model loaded'}
      >
        <StatusDot tone={ready ? 'success' : 'neutral'} />
      </button>

      <button
        type="button"
        className={`${styles.railButton} ${view === 'settings' ? styles.railButtonActive : ''}`}
        onClick={() => openSettings()}
        aria-label="Settings"
        title="Settings"
      >
        <Icon name="user" size={16} />
      </button>
    </div>
  )
}
