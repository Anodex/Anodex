import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useProjectStore } from '../../stores/projectStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUiStore } from '../../stores/uiStore'
import { useSidebarCollapse } from '../../stores/sidebarCollapseStore'
import { useCreateProject } from '../../hooks/useCreateProject'
import { isChatReady } from '../../lib/chatReadiness'
import type { NavigationBadgeCounts } from '../../lib/navigationBadges'
import { Icon } from '../Icon'
import { StatusDot } from '../ui/StatusDot'
import { NavigationCount } from './NavigationCount'
import styles from './SidebarRail.module.css'

interface SidebarRailProps {
  counts: NavigationBadgeCounts
}

/** Icon-only sidebar for narrow windows. Global nav still navigates directly;
 *  anything that needs the project/chat list opens the full sidebar as a
 *  temporary overlay instead of permanently squeezing the chat area. */
export function SidebarRail({ counts }: SidebarRailProps): JSX.Element {
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
        aria-label={`Scheduler${counts.scheduler > 0 ? `, ${counts.scheduler} new result${counts.scheduler === 1 ? '' : 's'}` : ''}`}
        title={`Scheduler${counts.scheduler > 0 ? ` (${counts.scheduler})` : ''}`}
      >
        <Icon name="clock" size={16} />
        <NavigationCount count={counts.scheduler} rail />
      </button>
      <button
        type="button"
        className={`${styles.railButton} ${view === 'agent' ? styles.railButtonActive : ''}`}
        onClick={() => setView('agent')}
        aria-label={`Agent${counts.agent > 0 ? `, ${counts.agent} notification${counts.agent === 1 ? '' : 's'}` : ''}`}
        title={`Agent${counts.agent > 0 ? ` (${counts.agent})` : ''}`}
      >
        <Icon name="bot" size={16} />
        <NavigationCount count={counts.agent} rail />
      </button>
      <button
        type="button"
        className={`${styles.railButton} ${view === 'critical-thinking' ? styles.railButtonActive : ''}`}
        onClick={() => setView('critical-thinking')}
        aria-label={`Critical Thinking${counts.criticalThinking > 0 ? `, ${counts.criticalThinking} notification${counts.criticalThinking === 1 ? '' : 's'}` : ''}`}
        title={`Critical Thinking${counts.criticalThinking > 0 ? ` (${counts.criticalThinking})` : ''}`}
      >
        <Icon name="insight" size={16} />
        <NavigationCount count={counts.criticalThinking} rail />
      </button>
      <button
        type="button"
        className={`${styles.railButton} ${view === 'email' ? styles.railButtonActive : ''}`}
        onClick={() => setView('email')}
        aria-label={`Email${counts.email > 0 ? `, ${counts.email} unread thread${counts.email === 1 ? '' : 's'}` : ''}`}
        title={`Email${counts.email > 0 ? ` (${counts.email})` : ''}`}
      >
        <Icon name="mail" size={16} />
        <NavigationCount count={counts.email} rail />
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
