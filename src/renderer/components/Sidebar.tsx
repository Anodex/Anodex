import { useMemo, useState } from 'react'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { useUiStore } from '../stores/uiStore'
import { useChatStore } from '../stores/chatStore'
import { useProjectStore } from '../stores/projectStore'
import { useSettingsStore } from '../stores/settingsStore'
import { DEFAULT_KEYBOARD_SHORTCUTS } from '@shared/keyboardShortcuts'
import type { Project } from '@shared/project.types'
import type { Conversation } from '@shared/conversation.types'
import type { NavigationBadgeCounts } from '../lib/navigationBadges'
import { Icon } from './Icon'
import { useCreateProject } from '../hooks/useCreateProject'
import { conversationsRelevantlyEqual } from '../lib/conversationEquality'
import { SidebarSearch } from './sidebar/SidebarSearch'
import { SidebarSection } from './sidebar/SidebarSection'
import { ProjectRow } from './sidebar/ProjectRow'
import { ChatRow } from './sidebar/ChatRow'
import { ChatsActionsMenu, type ChatSortMode } from './sidebar/ChatsActionsMenu'
import { SidebarProfile } from './sidebar/SidebarProfile'
import { ModelStatusMenu } from './sidebar/ModelStatusMenu'
import { NavigationCount } from './sidebar/NavigationCount'
import { ConfirmDialog } from './ui/ConfirmDialog'
import { findBodyMatches, matchesQuery } from './sidebar/conversationSearch'
import styles from './Sidebar.module.css'

interface FilteredProject {
  project: Project
  conversations: Conversation[]
}

interface SidebarProps {
  counts: NavigationBadgeCounts
}

/** Primary sidebar: top actions, collapsible project/chat trees, and profile footer. */
export function Sidebar({ counts }: SidebarProps): JSX.Element {
  const view = useUiStore((s) => s.view)
  const setView = useUiStore((s) => s.setView)
  const openSettings = useUiStore((s) => s.openSettings)
  const readConversationAt = useUiStore((s) => s.readConversationAt)
  const markConversationUnread = useUiStore((s) => s.markConversationUnread)

  const conversations = useStoreWithEqualityFn(
    useChatStore,
    (s) => s.conversations,
    conversationsRelevantlyEqual
  )
  const activeConversationId = useChatStore((s) => s.activeId)
  const newConversation = useChatStore((s) => s.newConversation)
  const selectConversation = useChatStore((s) => s.selectConversation)
  const renameConversation = useChatStore((s) => s.renameConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)

  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const setActiveProject = useProjectStore((s) => s.setActive)
  const updateProject = useProjectStore((s) => s.update)
  const openProjectFolder = useProjectStore((s) => s.openFolder)
  const archiveProject = useProjectStore((s) => s.archive)
  const confirmDestructive = useSettingsStore((s) => s.settings?.general.confirmDestructive ?? true)
  const searchShortcut =
    useSettingsStore((s) => s.settings?.keyboard.shortcuts.searchSidebar) ??
    DEFAULT_KEYBOARD_SHORTCUTS.searchSidebar
  const newChatShortcut =
    useSettingsStore((s) => s.settings?.keyboard.shortcuts.newChat) ??
    DEFAULT_KEYBOARD_SHORTCUTS.newChat
  const handleCreateProject = useCreateProject()

  const [searchQuery, setSearchQuery] = useState('')
  const [workspaceExpanded, setWorkspaceExpanded] = useState(true)
  const [chatsExpanded, setChatsExpanded] = useState(true)
  const [chatSortMode, setChatSortMode] = useState<ChatSortMode>('recent')
  const [expandedProjectIds, setExpandedProjectIds] = useState<Record<string, boolean>>({})
  const [archivingProject, setArchivingProject] = useState<Project | null>(null)
  const [confirmingArchiveChats, setConfirmingArchiveChats] = useState(false)

  const searching = searchQuery.trim().length > 0

  const { filteredProjects, generalChats, searchEmpty, matchExcerpts } = useMemo(() => {
    const query = searchQuery.trim()
    const projectChats = new Map<string, Conversation[]>()
    const general: Conversation[] = []
    // Scored once for the whole query rather than per conversation — a row
    // surfaces on a title match or on something said inside it.
    //
    // This reads message content through a subscription that deliberately
    // ignores it (`conversationsRelevantlyEqual`, which exists so a streaming
    // reply doesn't re-render the sidebar on every token). The consequence is
    // narrow and wanted: text in a reply that is still streaming isn't
    // searchable until that turn settles. Do not "fix" that by widening the
    // equality check — it would restore exactly the per-token re-render storm
    // that function was written to stop.
    const bodyMatches = findBodyMatches(conversations, query)
    const matched = (conversation: Conversation): boolean =>
      matchesQuery(conversation.title, query) || bodyMatches.ids.has(conversation.id)

    for (const conversation of conversations) {
      // A scheduled task's or agent run's conversation is a machine's log, not
      // a chat the user held — each lives inside its own view (Scheduler /
      // Agent), where the history and controls for it already are. Leaving them
      // here buried real conversations under one endlessly-appended thread each.
      if (conversation.origin === 'scheduled' || conversation.origin === 'agent') continue

      if (!conversation.projectId) {
        if (!query || matched(conversation)) general.push(conversation)
        continue
      }
      const list = projectChats.get(conversation.projectId) ?? []
      if (!query || matched(conversation)) list.push(conversation)
      projectChats.set(conversation.projectId, list)
    }

    const filtered: FilteredProject[] = []
    for (const project of projects) {
      const nameMatch = matchesQuery(project.name, query)
      const matchingChats = projectChats.get(project.id) ?? []
      if (!query || nameMatch || matchingChats.length > 0) {
        filtered.push({
          project,
          // If the project name matches, show all its chats; otherwise show only matching chats.
          conversations: !query || nameMatch ? (projectChats.get(project.id) ?? []) : matchingChats
        })
      }
    }

    // Sort projects by the most recent activity inside them.
    filtered.sort((a, b) => {
      const aTime = Math.max(a.project.createdAt, ...a.conversations.map((c) => c.updatedAt))
      const bTime = Math.max(b.project.createdAt, ...b.conversations.map((c) => c.updatedAt))
      return bTime - aTime
    })

    general.sort((a, b) => {
      if (chatSortMode === 'title') {
        return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
      }
      return b.updatedAt - a.updatedAt
    })

    return {
      filteredProjects: filtered,
      generalChats: general,
      searchEmpty: query.length > 0 && filtered.length === 0 && general.length === 0,
      matchExcerpts: bodyMatches.excerpts
    }
  }, [chatSortMode, conversations, projects, searchQuery])

  // Keep the active project first inside Workspace so "where you are" and
  // "what else is available" live in one predictable group.
  const activeProjectEntry = !searching
    ? (filteredProjects.find((p) => p.project.id === activeProjectId) ?? null)
    : null
  const remainingProjects = activeProjectEntry
    ? filteredProjects.filter((p) => p.project.id !== activeProjectId)
    : filteredProjects
  const workspaceProjects = activeProjectEntry
    ? [activeProjectEntry, ...remainingProjects]
    : remainingProjects

  const isProjectExpanded = (projectId: string): boolean =>
    searching || expandedProjectIds[projectId] !== false

  const toggleProject = (projectId: string): void => {
    setExpandedProjectIds((prev) => ({ ...prev, [projectId]: !isProjectExpanded(projectId) }))
  }

  const handleNewChat = (projectId?: string): void => {
    // Always sync the active project — including clearing it to null for a
    // general chat — so the main process doesn't keep scoping tool calls,
    // workspace files, and project memory to whatever project was active
    // before, leaking it into a chat the user intends to be project-free.
    void setActiveProject(projectId ?? null)
    newConversation(projectId ?? null)
    setView('chat')
  }

  const handleSelectConversation = (id: string): void => {
    const conversation = conversations.find((c) => c.id === id)
    void setActiveProject(conversation?.projectId ?? null)
    void selectConversation(id)
    setView('chat')
  }

  const handleDeleteConversation = (id: string): void => {
    void deleteConversation(id)
  }

  const archiveAllGeneralChats = async (): Promise<void> => {
    const generalConversationIds = conversations
      .filter((conversation) => conversation.projectId === null)
      .map((conversation) => conversation.id)
    for (const id of generalConversationIds) {
      await deleteConversation(id)
    }
  }

  const isConversationRunning = (conversation: Conversation): boolean =>
    conversation.messages.some((message) => message.streaming)

  const isConversationUnread = (conversation: Conversation): boolean => {
    if (conversation.id === activeConversationId) return false
    const readAt = readConversationAt[conversation.id]
    return Boolean(readAt && conversation.updatedAt > readAt)
  }

  const handleRenameProject = (project: Project, name: string): void => {
    void updateProject(project.id, { name })
  }

  const handleArchiveProject = (project: Project): void => {
    if (!confirmDestructive) {
      void archiveProject(project.id)
      return
    }
    setArchivingProject(project)
  }

  const handleCollapseAllProjects = (): void => {
    setExpandedProjectIds(Object.fromEntries(filteredProjects.map((p) => [p.project.id, false])))
  }

  const handleExpandAllProjects = (): void => {
    setWorkspaceExpanded(true)
    setExpandedProjectIds(Object.fromEntries(filteredProjects.map((p) => [p.project.id, true])))
  }

  const hasExpandedProjects = filteredProjects.some((p) => isProjectExpanded(p.project.id))

  return (
    <aside className={styles.sidebar}>
      <div className={styles.actions}>
        <button type="button" className={styles.newChatButton} onClick={() => handleNewChat()}>
          <Icon name="plus" size={14} className={styles.newChatIcon} />
          <span className={styles.newChatLabel}>New chat</span>
          {newChatShortcut && (
            <kbd className={styles.newChatShortcut}>{newChatShortcut.replace(/\+/g, ' ')}</kbd>
          )}
        </button>
        <SidebarSearch value={searchQuery} onChange={setSearchQuery} shortcut={searchShortcut} />
      </div>

      <div className={styles.scroll}>
        {searchEmpty ? (
          <div className={styles.searchEmpty}>
            <Icon name="search" size={20} />
            <p>No results for &quot;{searchQuery}&quot;</p>
          </div>
        ) : (
          <>
            <div className={styles.globalNav}>
              <button
                type="button"
                className={`${styles.navItem} ${view === 'scheduler' ? styles.navItemActive : ''}`}
                onClick={() => setView('scheduler')}
                aria-current={view === 'scheduler' ? 'page' : undefined}
                aria-label={`Scheduler${counts.scheduler > 0 ? `, ${counts.scheduler} new result${counts.scheduler === 1 ? '' : 's'}` : ''}`}
              >
                <Icon name="clock" size={14} className={styles.navItemIcon} />
                <span className={styles.navItemLabel}>Scheduler</span>
                <NavigationCount count={counts.scheduler} />
              </button>

              <button
                type="button"
                className={`${styles.navItem} ${view === 'agent' ? styles.navItemActive : ''}`}
                onClick={() => setView('agent')}
                aria-current={view === 'agent' ? 'page' : undefined}
                aria-label={`Agent${counts.agent > 0 ? `, ${counts.agent} notification${counts.agent === 1 ? '' : 's'}` : ''}`}
              >
                <Icon name="bot" size={14} className={styles.navItemIcon} />
                <span className={styles.navItemLabel}>Agent</span>
                <NavigationCount count={counts.agent} />
              </button>

              <button
                type="button"
                className={`${styles.navItem} ${
                  view === 'critical-thinking' ? styles.navItemActive : ''
                }`}
                onClick={() => setView('critical-thinking')}
                aria-current={view === 'critical-thinking' ? 'page' : undefined}
                aria-label={`Critical Thinking${counts.criticalThinking > 0 ? `, ${counts.criticalThinking} notification${counts.criticalThinking === 1 ? '' : 's'}` : ''}`}
              >
                <Icon name="insight" size={14} className={styles.navItemIcon} />
                <span className={styles.navItemLabel}>Critical Thinking</span>
                <NavigationCount count={counts.criticalThinking} />
              </button>

              <button
                type="button"
                className={`${styles.navItem} ${view === 'email' ? styles.navItemActive : ''}`}
                onClick={() => setView('email')}
                aria-current={view === 'email' ? 'page' : undefined}
                aria-label={`Email${counts.email > 0 ? `, ${counts.email} unread thread${counts.email === 1 ? '' : 's'}` : ''}`}
              >
                <Icon name="mail" size={14} className={styles.navItemIcon} />
                <span className={styles.navItemLabel}>Email</span>
                <NavigationCount count={counts.email} />
              </button>
            </div>

            <SidebarSection
              title="Workspace"
              icon="folder"
              count={workspaceProjects.length}
              expanded={searching || workspaceExpanded}
              onToggle={() => setWorkspaceExpanded((v) => !v)}
              actions={
                <div className={styles.headerActions}>
                  {hasExpandedProjects && (
                    <button
                      type="button"
                      className={styles.headerIcon}
                      onClick={handleCollapseAllProjects}
                      aria-label="Collapse all projects"
                      title="Collapse all"
                    >
                      <Icon name="chevrons-up" size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.headerIcon}
                    onClick={() => void handleCreateProject()}
                    aria-label="New project"
                    title="New project"
                  >
                    <Icon name="folder-plus" size={14} />
                  </button>
                </div>
              }
            >
              {workspaceProjects.length === 0 ? (
                <div className={styles.sectionEmpty}>
                  <p>No projects yet</p>
                </div>
              ) : (
                workspaceProjects.map(({ project, conversations: projectConversations }) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    conversations={projectConversations}
                    active={project.id === activeProjectId}
                    expanded={isProjectExpanded(project.id)}
                    activeConversationId={activeConversationId}
                    running={projectConversations.some(isConversationRunning)}
                    unread={projectConversations.some(isConversationUnread)}
                    readConversationAt={readConversationAt}
                    matchExcerpts={matchExcerpts}
                    onToggle={() => toggleProject(project.id)}
                    onNewChat={handleNewChat}
                    onSelectConversation={handleSelectConversation}
                    onRenameConversation={(id, title) => void renameConversation(id, title)}
                    onMarkConversationUnread={(id, updatedAt) =>
                      markConversationUnread(id, updatedAt)
                    }
                    onDeleteConversation={handleDeleteConversation}
                    onOpenProjectFolder={(id) => void openProjectFolder(id)}
                    onRename={handleRenameProject}
                    onArchive={handleArchiveProject}
                  />
                ))
              )}
            </SidebarSection>

            <SidebarSection
              title="Chats"
              icon="chat"
              count={generalChats.length}
              expanded={searching || chatsExpanded}
              onToggle={() => setChatsExpanded((v) => !v)}
              actions={
                <div className={styles.headerActions}>
                  <ChatsActionsMenu
                    chatCount={generalChats.length}
                    sortMode={chatSortMode}
                    onSortModeChange={setChatSortMode}
                    onArchiveAll={() => {
                      if (!confirmDestructive) {
                        void archiveAllGeneralChats()
                        return
                      }
                      setConfirmingArchiveChats(true)
                    }}
                    onExpandProjects={handleExpandAllProjects}
                    onCollapseProjects={handleCollapseAllProjects}
                  />
                  <button
                    type="button"
                    className={styles.headerIcon}
                    onClick={() => handleNewChat()}
                    aria-label="New chat"
                    title="New chat"
                  >
                    <Icon name="plus" size={14} />
                  </button>
                </div>
              }
            >
              {generalChats.length === 0 ? (
                <div className={styles.sectionEmpty}>
                  <p>No general chats yet</p>
                </div>
              ) : (
                generalChats.map((conversation) => (
                  <ChatRow
                    key={conversation.id}
                    conversation={conversation}
                    active={conversation.id === activeConversationId}
                    running={isConversationRunning(conversation)}
                    unread={isConversationUnread(conversation)}
                    excerpt={matchExcerpts.get(conversation.id)}
                    onClick={() => void handleSelectConversation(conversation.id)}
                    onRename={(title) => void renameConversation(conversation.id, title)}
                    onMarkUnread={() =>
                      markConversationUnread(conversation.id, conversation.updatedAt)
                    }
                    onDelete={() => handleDeleteConversation(conversation.id)}
                  />
                ))
              )}
            </SidebarSection>
          </>
        )}
      </div>

      <footer className={styles.footer}>
        <ModelStatusMenu />
        <SidebarProfile active={view === 'settings'} onClick={() => openSettings()} />
      </footer>

      {archivingProject && (
        <ConfirmDialog
          title="Archive project?"
          message="Its chats will move to Settings → Archive with the project."
          detail={archivingProject.name}
          confirmLabel="Archive"
          icon="archive"
          onCancel={() => setArchivingProject(null)}
          onConfirm={() => {
            void archiveProject(archivingProject.id)
            setArchivingProject(null)
          }}
        />
      )}

      {confirmingArchiveChats && (
        <ConfirmDialog
          title="Archive all general chats?"
          message="These chats will move to Settings → Archive, where you can restore or permanently delete them."
          detail={`${conversations.filter((conversation) => conversation.projectId === null).length} chat${
            conversations.filter((conversation) => conversation.projectId === null).length === 1
              ? ''
              : 's'
          }`}
          confirmLabel="Archive all"
          icon="archive"
          onCancel={() => setConfirmingArchiveChats(false)}
          onConfirm={() => {
            setConfirmingArchiveChats(false)
            void archiveAllGeneralChats()
          }}
        />
      )}
    </aside>
  )
}
