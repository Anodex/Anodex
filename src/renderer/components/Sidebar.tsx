import { useMemo, useState } from 'react'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { useUiStore } from '../stores/uiStore'
import { useChatStore } from '../stores/chatStore'
import { useProjectStore } from '../stores/projectStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { Project } from '@shared/project.types'
import type { Conversation } from '@shared/conversation.types'
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
import { ConfirmDialog } from './ui/ConfirmDialog'
import styles from './Sidebar.module.css'

function matchesQuery(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase())
}

interface FilteredProject {
  project: Project
  conversations: Conversation[]
}

/** Primary sidebar: top actions, collapsible project/chat trees, and profile footer. */
export function Sidebar(): JSX.Element {
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
  const deleteProject = useProjectStore((s) => s.delete)
  const confirmDestructive = useSettingsStore((s) => s.settings?.general.confirmDestructive ?? true)
  const handleCreateProject = useCreateProject()

  const [searchQuery, setSearchQuery] = useState('')
  const [projectsExpanded, setProjectsExpanded] = useState(true)
  const [chatsExpanded, setChatsExpanded] = useState(true)
  const [chatSortMode, setChatSortMode] = useState<ChatSortMode>('recent')
  const [expandedProjectIds, setExpandedProjectIds] = useState<Record<string, boolean>>({})
  const [deletingProject, setDeletingProject] = useState<Project | null>(null)
  const [confirmingArchiveChats, setConfirmingArchiveChats] = useState(false)

  const searching = searchQuery.trim().length > 0

  const { filteredProjects, generalChats, searchEmpty } = useMemo(() => {
    const query = searchQuery.trim()
    const projectChats = new Map<string, Conversation[]>()
    const general: Conversation[] = []

    for (const conversation of conversations) {
      if (!conversation.projectId) {
        if (!query || matchesQuery(conversation.title, query)) general.push(conversation)
        continue
      }
      const list = projectChats.get(conversation.projectId) ?? []
      if (!query || matchesQuery(conversation.title, query)) list.push(conversation)
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
      searchEmpty: query.length > 0 && filtered.length === 0 && general.length === 0
    }
  }, [chatSortMode, conversations, projects, searchQuery])

  // Pin the active project above the Projects list so it reads as "where you
  // are" rather than one peer among many. Skip the split while searching —
  // a flat filtered list is clearer there than a hierarchy.
  const activeProjectEntry = !searching
    ? (filteredProjects.find((p) => p.project.id === activeProjectId) ?? null)
    : null
  const otherProjects = activeProjectEntry
    ? filteredProjects.filter((p) => p.project.id !== activeProjectId)
    : filteredProjects

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

  const handleDeleteProject = (project: Project): void => {
    if (!confirmDestructive) {
      void deleteProject(project.id)
      return
    }
    setDeletingProject(project)
  }

  const handleCollapseAllProjects = (): void => {
    setExpandedProjectIds(Object.fromEntries(filteredProjects.map((p) => [p.project.id, false])))
  }

  const handleExpandAllProjects = (): void => {
    setProjectsExpanded(true)
    setExpandedProjectIds(Object.fromEntries(filteredProjects.map((p) => [p.project.id, true])))
  }

  const hasExpandedProjects = filteredProjects.some((p) => isProjectExpanded(p.project.id))

  return (
    <aside className={styles.sidebar}>
      <div className={styles.actions}>
        <SidebarSearch value={searchQuery} onChange={setSearchQuery} shortcutHint="Ctrl K" />
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
              >
                <Icon name="clock" size={14} className={styles.navItemIcon} />
                <span>Scheduler</span>
              </button>

              <button
                type="button"
                className={`${styles.navItem} ${view === 'agent' ? styles.navItemActive : ''}`}
                onClick={() => setView('agent')}
                aria-current={view === 'agent' ? 'page' : undefined}
              >
                <Icon name="bot" size={14} className={styles.navItemIcon} />
                <span>Agent</span>
              </button>

              <button
                type="button"
                className={`${styles.navItem} ${
                  view === 'critical-thinking' ? styles.navItemActive : ''
                }`}
                onClick={() => setView('critical-thinking')}
                aria-current={view === 'critical-thinking' ? 'page' : undefined}
              >
                <Icon name="insight" size={14} className={styles.navItemIcon} />
                <span>Critical Thinking</span>
              </button>

              <button
                type="button"
                className={`${styles.navItem} ${view === 'email' ? styles.navItemActive : ''}`}
                onClick={() => setView('email')}
                aria-current={view === 'email' ? 'page' : undefined}
              >
                <Icon name="mail" size={14} className={styles.navItemIcon} />
                <span>Email</span>
              </button>
            </div>

            {activeProjectEntry && (
              <div className={styles.activeProjectPin}>
                <div className={styles.activeProjectLabel}>Current project</div>
                <ProjectRow
                  project={activeProjectEntry.project}
                  conversations={activeProjectEntry.conversations}
                  active
                  expanded={isProjectExpanded(activeProjectEntry.project.id)}
                  activeConversationId={activeConversationId}
                  running={activeProjectEntry.conversations.some(isConversationRunning)}
                  unread={activeProjectEntry.conversations.some(isConversationUnread)}
                  readConversationAt={readConversationAt}
                  onToggle={() => toggleProject(activeProjectEntry.project.id)}
                  onNewChat={handleNewChat}
                  onSelectConversation={handleSelectConversation}
                  onRenameConversation={(id, title) => void renameConversation(id, title)}
                  onMarkConversationUnread={(id, updatedAt) =>
                    markConversationUnread(id, updatedAt)
                  }
                  onDeleteConversation={handleDeleteConversation}
                  onOpenProjectFolder={(id) => void openProjectFolder(id)}
                  onRename={handleRenameProject}
                  onDelete={handleDeleteProject}
                />
              </div>
            )}

            <SidebarSection
              title={activeProjectEntry ? 'Other projects' : 'Projects'}
              icon="folder"
              expanded={searching || projectsExpanded}
              onToggle={() => setProjectsExpanded((v) => !v)}
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
              {otherProjects.length === 0 ? (
                <div className={styles.sectionEmpty}>
                  <p>{activeProjectEntry ? 'No other projects' : 'No projects yet'}</p>
                </div>
              ) : (
                otherProjects.map(({ project, conversations: projectConversations }) => (
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
                    onDelete={handleDeleteProject}
                  />
                ))
              )}
            </SidebarSection>

            <SidebarSection
              title="Chats"
              icon="chat"
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

      {deletingProject && (
        <ConfirmDialog
          title="Archive project?"
          message="Its chats will move to Settings → Archive with the project."
          detail={deletingProject.name}
          confirmLabel="Archive"
          icon="archive"
          onCancel={() => setDeletingProject(null)}
          onConfirm={() => {
            void deleteProject(deletingProject.id)
            setDeletingProject(null)
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
