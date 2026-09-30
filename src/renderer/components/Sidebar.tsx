import { useMemo, useState } from 'react'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { useUiStore } from '../stores/uiStore'
import { useChatStore } from '../stores/chatStore'
import { useProjectStore } from '../stores/projectStore'
import { useSettingsStore } from '../stores/settingsStore'
import { DEFAULT_KEYBOARD_SHORTCUTS } from '@shared/keyboardShortcuts'
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
import { ModelStatusMenu } from './sidebar/ModelStatusMenu'
import { SidebarModeSwitcher } from './sidebar/SidebarModeSwitcher'
import { ConfirmDialog } from './ui/ConfirmDialog'
import { useSidebarCollapse } from '../stores/sidebarCollapseStore'
import {
  resolveSidebarMode,
  useSidebarModeStore,
  type SidebarMode
} from '../stores/sidebarModeStore'
import { matchesQuery, useBodyMatches } from './sidebar/conversationSearch'
import styles from './Sidebar.module.css'

interface FilteredProject {
  project: Project
  conversations: Conversation[]
}

/** Project and chat panel beside the persistent navigation rail. */
export function Sidebar(): JSX.Element {
  const setView = useUiStore((s) => s.setView)
  const searchFocusPending = useSidebarCollapse((s) => s.searchFocusPending)
  const clearSearchFocus = useSidebarCollapse((s) => s.clearSearchFocus)
  const closeOverlay = useSidebarCollapse((s) => s.setOverlayOpen)
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
  const savedMode = useSidebarModeStore((s) => s.mode)
  const setMode = useSidebarModeStore((s) => s.setMode)
  const mode = resolveSidebarMode(savedMode, activeProjectId)
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
  const newProjectShortcut =
    useSettingsStore((s) => s.settings?.keyboard.shortcuts.newProject) ??
    DEFAULT_KEYBOARD_SHORTCUTS.newProject
  const handleCreateProject = useCreateProject()

  const [searchQueries, setSearchQueries] = useState<Record<SidebarMode, string>>({
    chats: '',
    workspace: ''
  })
  const searchQuery = searchQueries[mode]
  const [workspaceExpanded, setWorkspaceExpanded] = useState(true)
  const [chatsExpanded, setChatsExpanded] = useState(true)
  const [chatSortMode, setChatSortMode] = useState<ChatSortMode>('recent')
  const [expandedProjectIds, setExpandedProjectIds] = useState<Record<string, boolean>>({})
  const [archivingProject, setArchivingProject] = useState<Project | null>(null)
  const [confirmingArchiveChats, setConfirmingArchiveChats] = useState(false)

  const searching = searchQuery.trim().length > 0
  const bodyMatches = useBodyMatches(searchQuery)

  const { filteredProjects, generalChats, matchExcerpts } = useMemo(() => {
    const query = searchQuery.trim()
    const projectChats = new Map<string, Conversation[]>()
    const general: Conversation[] = []
    // A row surfaces on a title match or on something said inside it. What was
    // said is searched on the computer (`useBodyMatches`), which holds every
    // conversation's messages; this window reads only the ones opened. A reply
    // still streaming is searchable once it is saved.
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
      matchExcerpts: bodyMatches.excerpts
    }
  }, [bodyMatches, chatSortMode, conversations, projects, searchQuery])

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
  const searchEmpty =
    searching && (mode === 'workspace' ? workspaceProjects.length === 0 : generalChats.length === 0)

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
    setMode(projectId ? 'workspace' : 'chats')
    newConversation(projectId ?? null)
    setView('chat')
    closeOverlay(false)
  }

  const handleSelectConversation = (id: string): void => {
    const conversation = conversations.find((c) => c.id === id)
    void setActiveProject(conversation?.projectId ?? null)
    setMode(conversation?.projectId ? 'workspace' : 'chats')
    void selectConversation(id)
    setView('chat')
    closeOverlay(false)
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

  const primaryLabel = mode === 'workspace' ? 'New project' : 'New chat'
  const primaryShortcut = mode === 'workspace' ? newProjectShortcut : newChatShortcut

  return (
    <aside className={styles.sidebar}>
      <SidebarModeSwitcher mode={mode} onChange={setMode} />
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={() => (mode === 'workspace' ? void handleCreateProject() : handleNewChat())}
          title={
            primaryShortcut
              ? `${primaryLabel} (${primaryShortcut.replace(/\+/g, ' ')})`
              : primaryLabel
          }
        >
          <Icon
            name={mode === 'workspace' ? 'folder-plus' : 'plus'}
            size={14}
            className={styles.primaryIcon}
          />
          <span className={styles.primaryLabel}>{primaryLabel}</span>
          {primaryShortcut && (
            <kbd className={styles.primaryShortcut}>{primaryShortcut.replace(/\+/g, ' ')}</kbd>
          )}
        </button>
        <SidebarSearch
          value={searchQuery}
          onChange={(value) => setSearchQueries((queries) => ({ ...queries, [mode]: value }))}
          shortcut={searchShortcut}
          focusRequested={searchFocusPending}
          onFocusRequestHandled={clearSearchFocus}
        />
      </div>

      <div className={styles.scroll}>
        {searchEmpty ? (
          <div className={styles.searchEmpty}>
            <Icon name="search" size={20} />
            <p>No results for &quot;{searchQuery}&quot;</p>
          </div>
        ) : mode === 'workspace' ? (
          <SidebarSection
            title="Projects"
            icon="folder"
            count={workspaceProjects.length}
            expanded={searching || workspaceExpanded}
            onToggle={() => setWorkspaceExpanded((v) => !v)}
            actions={
              <div className={styles.headerActions}>
                <button
                  type="button"
                  className={styles.headerIcon}
                  onClick={
                    hasExpandedProjects ? handleCollapseAllProjects : handleExpandAllProjects
                  }
                  aria-label={hasExpandedProjects ? 'Collapse all projects' : 'Expand all projects'}
                  title={hasExpandedProjects ? 'Collapse all' : 'Expand all'}
                >
                  <Icon name={hasExpandedProjects ? 'chevrons-up' : 'chevron-down'} size={14} />
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
        ) : (
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
                />
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
        )}
      </div>

      <footer className={styles.footer}>
        <ModelStatusMenu />
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
