import { useMemo, useState } from 'react'
import { useUiStore } from '../stores/uiStore'
import { useModelStore } from '../stores/modelStore'
import { useChatStore } from '../stores/chatStore'
import { useProjectStore } from '../stores/projectStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { Project } from '@shared/project.types'
import type { Conversation } from '@shared/conversation.types'
import type { EngineState } from '@shared/model.types'
import { Icon } from './Icon'
import { anodex } from '../lib/anodex'
import { notifyError } from '../stores/uiStore'
import { SidebarSearch } from './sidebar/SidebarSearch'
import { SidebarSection } from './sidebar/SidebarSection'
import { ProjectRow } from './sidebar/ProjectRow'
import { ChatRow } from './sidebar/ChatRow'
import { AgentPanel } from './sidebar/AgentPanel'
import { CriticalThinkingPanel } from './sidebar/CriticalThinkingPanel'
import { SchedulerPanel } from './sidebar/SchedulerPanel'
import { SidebarProfile } from './sidebar/SidebarProfile'
import { ConfirmDialog } from './ui/ConfirmDialog'
import styles from './Sidebar.module.css'

function statusTone(status: EngineState['status']): string {
  if (status === 'ready') return 'ready'
  if (status === 'loading') return 'busy'
  if (status === 'error') return 'error'
  return 'idle'
}

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
  const readConversationAt = useUiStore((s) => s.readConversationAt)
  const engine = useModelStore((s) => s.engine)

  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeId)
  const newConversation = useChatStore((s) => s.newConversation)
  const selectConversation = useChatStore((s) => s.selectConversation)
  const renameConversation = useChatStore((s) => s.renameConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)

  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const createProject = useProjectStore((s) => s.create)
  const setActiveProject = useProjectStore((s) => s.setActive)
  const updateProject = useProjectStore((s) => s.update)
  const openProjectFolder = useProjectStore((s) => s.openFolder)
  const deleteProject = useProjectStore((s) => s.delete)
  const confirmDestructive = useSettingsStore((s) => s.settings?.general.confirmDestructive ?? true)

  const [searchQuery, setSearchQuery] = useState('')
  // These three are all "coming soon" placeholders with no working backend yet
  // (see AgentPanel/SchedulerPanel/CriticalThinkingPanel) — collapsed by
  // default so they don't permanently occupy sidebar space for features that
  // don't do anything yet.
  const [agentExpanded, setAgentExpanded] = useState(false)
  const [schedulerExpanded, setSchedulerExpanded] = useState(false)
  const [criticalThinkingExpanded, setCriticalThinkingExpanded] = useState(false)
  const [projectsExpanded, setProjectsExpanded] = useState(true)
  const [chatsExpanded, setChatsExpanded] = useState(true)
  const [expandedProjectIds, setExpandedProjectIds] = useState<Record<string, boolean>>({})
  const [deletingProject, setDeletingProject] = useState<Project | null>(null)

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

    general.sort((a, b) => b.updatedAt - a.updatedAt)

    return {
      filteredProjects: filtered,
      generalChats: general,
      searchEmpty: query.length > 0 && filtered.length === 0 && general.length === 0
    }
  }, [conversations, projects, searchQuery])

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

  const isConversationRunning = (conversation: Conversation): boolean =>
    conversation.messages.some((message) => message.streaming)

  const isConversationUnread = (conversation: Conversation): boolean => {
    if (conversation.id === activeConversationId) return false
    const readAt = readConversationAt[conversation.id]
    return Boolean(readAt && conversation.updatedAt > readAt)
  }

  const handleCreateProject = async (): Promise<void> => {
    const result = await anodex.tools.pickWorkspace()
    if (!result.ok) {
      notifyError('Could not select folder', result.error.message)
      return
    }
    const folderPath = result.value
    if (!folderPath) return
    const name = folderPath.split(/[/\\]/).pop() ?? 'New project'
    await createProject({ name, folderPath })
    setView('chat')
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

  const hasExpandedProjects = filteredProjects.some((p) => isProjectExpanded(p.project.id))

  return (
    <aside className={styles.sidebar}>
      <div className={styles.actions}>
        <SidebarSearch value={searchQuery} onChange={setSearchQuery} />
      </div>

      <div className={styles.scroll}>
        {searchEmpty ? (
          <div className={styles.searchEmpty}>
            <Icon name="search" size={20} />
            <p>No results for &quot;{searchQuery}&quot;</p>
          </div>
        ) : (
          <>
            <SidebarSection
              title="Scheduler"
              icon="clock"
              expanded={schedulerExpanded}
              onToggle={() => setSchedulerExpanded((v) => !v)}
            >
              <SchedulerPanel />
            </SidebarSection>

            <SidebarSection
              title="Agent"
              icon="wand"
              expanded={agentExpanded}
              onToggle={() => setAgentExpanded((v) => !v)}
            >
              <AgentPanel />
            </SidebarSection>

            <SidebarSection
              title="Critical Thinking"
              icon="globe"
              expanded={criticalThinkingExpanded}
              onToggle={() => setCriticalThinkingExpanded((v) => !v)}
            >
              <CriticalThinkingPanel />
            </SidebarSection>

            <SidebarSection
              title="Projects"
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
              {filteredProjects.length === 0 ? (
                <div className={styles.sectionEmpty}>
                  <p>No projects yet</p>
                </div>
              ) : (
                filteredProjects.map(({ project, conversations: projectConversations }) => (
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
                <button
                  type="button"
                  className={styles.headerIcon}
                  onClick={() => handleNewChat()}
                  aria-label="New chat"
                  title="New chat"
                >
                  <Icon name="plus" size={14} />
                </button>
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
                    onDelete={() => handleDeleteConversation(conversation.id)}
                  />
                ))
              )}
            </SidebarSection>
          </>
        )}
      </div>

      <footer className={styles.footer}>
        <button
          type="button"
          className={styles.status}
          onClick={() => setView('settings')}
          title="Model status — click to open settings"
        >
          <span className={`${styles.statusDot} ${styles[statusTone(engine.status)]}`} />
          <span className={styles.statusText}>{engine.model?.name ?? 'No model loaded'}</span>
        </button>
        <SidebarProfile active={view === 'settings'} onClick={() => setView('settings')} />
      </footer>

      {deletingProject && (
        <ConfirmDialog
          title="Delete project?"
          message="Its chats will also be deleted."
          detail={deletingProject.name}
          confirmLabel="Delete"
          onCancel={() => setDeletingProject(null)}
          onConfirm={() => {
            void deleteProject(deletingProject.id)
            setDeletingProject(null)
          }}
        />
      )}
    </aside>
  )
}
