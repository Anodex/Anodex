import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useProjectStore } from '../../stores/projectStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUiStore, type AppView } from '../../stores/uiStore'
import { useSidebarCollapse } from '../../stores/sidebarCollapseStore'
import { useSidebarModeStore } from '../../stores/sidebarModeStore'
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

/** Persistent navigation rail. The project/chat panel opens beside it. */
export function SidebarRail({ counts }: SidebarRailProps): JSX.Element {
  const view = useUiStore((s) => s.view)
  const setView = useUiStore((s) => s.setView)
  const openSettings = useUiStore((s) => s.openSettings)
  const newConversation = useChatStore((s) => s.newConversation)
  const setActiveProject = useProjectStore((s) => s.setActive)
  const setMode = useSidebarModeStore((s) => s.setMode)
  const settings = useSettingsStore((s) => s.settings)
  const engineStatus = useModelStore((s) => s.engine.status)
  const ready = isChatReady(settings, engineStatus)
  const expandSidebar = useSidebarCollapse((s) => s.expand)
  const toggleSidebar = useSidebarCollapse((s) => s.toggle)
  const overlayOpen = useSidebarCollapse((s) => s.overlayOpen)
  const autoCollapsed = useSidebarCollapse((s) => s.autoCollapsed)
  const manuallyCollapsed = useSidebarCollapse((s) => s.manuallyCollapsed)
  const setOverlayOpen = useSidebarCollapse((s) => s.setOverlayOpen)
  const requestSearch = useSidebarCollapse((s) => s.requestSearch)
  const handleCreateProject = useCreateProject()
  const showCollapsedOnlyControls = (autoCollapsed || manuallyCollapsed) && !overlayOpen

  const navigate = (nextView: AppView): void => {
    setView(nextView)
    setOverlayOpen(false)
  }

  const handleChat = (): void => {
    if (view !== 'chat') {
      navigate('chat')
      expandSidebar()
    } else if (overlayOpen) {
      setOverlayOpen(false)
    } else {
      toggleSidebar()
    }
  }

  const handleNewChat = (): void => {
    void setActiveProject(null)
    setMode('chats')
    newConversation(null)
    navigate('chat')
  }

  const handleNewProject = (): void => {
    setMode('workspace')
    expandSidebar()
    void handleCreateProject()
  }

  return (
    <div className={styles.rail}>
      <button
        type="button"
        className={`${styles.railButton} ${view === 'chat' ? styles.railButtonActive : ''}`}
        onClick={handleChat}
        aria-label="Chat"
        aria-current={view === 'chat' ? 'page' : undefined}
        title="Chat"
      >
        <Icon name="chat" size={16} />
      </button>
      <button
        type="button"
        className={styles.railButton}
        onClick={requestSearch}
        aria-label="Search chats and projects"
        data-tour="search"
        title="Search chats and projects"
      >
        <Icon name="search" size={16} />
      </button>
      <div className={styles.railDivider} />
      <button
        type="button"
        className={`${styles.railButton} ${view === 'scheduler' ? styles.railButtonActive : ''}`}
        onClick={() => navigate('scheduler')}
        data-tour="scheduler"
        aria-current={view === 'scheduler' ? 'page' : undefined}
        aria-label={`Scheduler${counts.scheduler > 0 ? `, ${counts.scheduler} new result${counts.scheduler === 1 ? '' : 's'}` : ''}`}
        title={`Scheduler${counts.scheduler > 0 ? ` (${counts.scheduler})` : ''}`}
      >
        <Icon name="clock" size={16} />
        <NavigationCount count={counts.scheduler} rail />
      </button>
      <button
        type="button"
        className={`${styles.railButton} ${view === 'agent' ? styles.railButtonActive : ''}`}
        onClick={() => navigate('agent')}
        data-tour="agent"
        aria-current={view === 'agent' ? 'page' : undefined}
        aria-label={`Agent${counts.agent > 0 ? `, ${counts.agent} notification${counts.agent === 1 ? '' : 's'}` : ''}`}
        title={`Agent${counts.agent > 0 ? ` (${counts.agent})` : ''}`}
      >
        <Icon name="bot" size={16} />
        <NavigationCount count={counts.agent} rail />
      </button>
      <button
        type="button"
        className={`${styles.railButton} ${view === 'critical-thinking' ? styles.railButtonActive : ''}`}
        onClick={() => navigate('critical-thinking')}
        data-tour="critical-thinking"
        aria-current={view === 'critical-thinking' ? 'page' : undefined}
        aria-label={`Critical Thinking${counts.criticalThinking > 0 ? `, ${counts.criticalThinking} notification${counts.criticalThinking === 1 ? '' : 's'}` : ''}`}
        title={`Critical Thinking${counts.criticalThinking > 0 ? ` (${counts.criticalThinking})` : ''}`}
      >
        <Icon name="insight" size={16} />
        <NavigationCount count={counts.criticalThinking} rail />
      </button>
      <button
        type="button"
        className={`${styles.railButton} ${view === 'email' ? styles.railButtonActive : ''}`}
        onClick={() => navigate('email')}
        data-tour="email"
        aria-current={view === 'email' ? 'page' : undefined}
        aria-label={`Email${counts.email > 0 ? `, ${counts.email} unread thread${counts.email === 1 ? '' : 's'}` : ''}`}
        title={`Email${counts.email > 0 ? ` (${counts.email})` : ''}`}
      >
        <Icon name="mail" size={16} />
        <NavigationCount count={counts.email} rail />
      </button>

      <div className={styles.railSpacer} />

      {showCollapsedOnlyControls && (
        <>
          <button
            type="button"
            className={styles.railButton}
            onClick={handleNewProject}
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
            onClick={() => {
              setOverlayOpen(false)
              openSettings('ai-models')
            }}
            aria-label="Model status"
            title={ready ? 'Model ready' : 'No model loaded'}
          >
            <StatusDot tone={ready ? 'success' : 'neutral'} />
          </button>
        </>
      )}

      <button
        type="button"
        className={`${styles.railButton} ${view === 'settings' ? styles.railButtonActive : ''}`}
        onClick={() => {
          setOverlayOpen(false)
          openSettings()
        }}
        aria-label="Profile and settings"
        data-tour="profile"
        title="Profile and settings"
      >
        {settings?.profile.avatarBase64 ? (
          <img src={settings.profile.avatarBase64} alt="" className={styles.profileImage} />
        ) : (
          <Icon name="user" size={16} />
        )}
      </button>
    </div>
  )
}
