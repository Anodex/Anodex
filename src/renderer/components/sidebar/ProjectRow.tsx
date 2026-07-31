import { useState } from 'react'
import type { Project } from '@shared/project.types'
import type { Conversation } from '@shared/conversation.types'
import { Icon } from '../Icon'
import { ChatRow } from './ChatRow'
import { ProjectActionsMenu } from './ProjectActionsMenu'
import styles from './ProjectRow.module.css'

interface ProjectRowProps {
  project: Project
  conversations: Conversation[]
  active: boolean
  expanded: boolean
  activeConversationId: string | null
  running: boolean
  unread: boolean
  readConversationAt: Record<string, number>
  /** Search excerpts by conversation id — see `ChatRow`'s own `excerpt` prop. */
  matchExcerpts?: Map<string, string>
  onToggle: () => void
  onNewChat: (projectId: string) => void
  onSelectConversation: (conversationId: string) => void
  onRenameConversation: (conversationId: string, title: string) => void
  onMarkConversationUnread: (conversationId: string, updatedAt: number) => void
  onDeleteConversation: (conversationId: string) => void
  onOpenProjectFolder: (projectId: string) => void
  onRename: (project: Project, name: string) => void
  onArchive: (project: Project) => void
}

/** A project row with expand/collapse, new-chat action, and its chat list. */
export function ProjectRow({
  project,
  conversations,
  active,
  expanded,
  activeConversationId,
  running,
  unread,
  readConversationAt,
  matchExcerpts,
  onToggle,
  onNewChat,
  onSelectConversation,
  onRenameConversation,
  onMarkConversationUnread,
  onDeleteConversation,
  onOpenProjectFolder,
  onRename,
  onArchive
}: ProjectRowProps): JSX.Element {
  const [hovered, setHovered] = useState(false)
  const showRunningGlow = !expanded && running
  const showUnreadDot = !expanded && !running && unread

  const isConversationRunning = (conversation: Conversation): boolean =>
    conversation.messages.some((message) => message.streaming)

  const isConversationUnread = (conversation: Conversation): boolean => {
    if (conversation.id === activeConversationId) return false
    const readAt = readConversationAt[conversation.id]
    return Boolean(readAt && conversation.updatedAt > readAt)
  }

  return (
    <div
      className={`${styles.project} ${active ? styles.projectActive : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={styles.header}>
        <button type="button" className={styles.toggle} onClick={onToggle} title={project.name}>
          <span className={styles.titleWrap}>
            <span className={styles.name}>{project.name}</span>
            {showRunningGlow && (
              <span className={styles.runTrack} aria-hidden="true">
                <span className={styles.runHalo} />
                <span className={styles.runCore} />
              </span>
            )}
          </span>
          <Icon
            name="chevron-down"
            size={12}
            className={`${styles.chevron} ${expanded ? '' : styles.chevronCollapsed}`}
          />
          {showUnreadDot && (
            <span className={styles.status}>
              <span className={styles.unreadDot} aria-hidden="true" />
            </span>
          )}
        </button>
        <div className={`${styles.actions} ${hovered ? styles.actionsVisible : ''}`}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => onNewChat(project.id)}
            aria-label="New chat in project"
            title="New chat in project"
          >
            <Icon name="plus" size={12} />
          </button>
          <ProjectActionsMenu
            project={project}
            onOpenProjectFolder={onOpenProjectFolder}
            onRename={onRename}
            onArchive={onArchive}
          />
        </div>
      </div>

      {expanded && (
        <div className={styles.chats}>
          {conversations.length === 0 ? (
            <div className={styles.empty}>No chats yet</div>
          ) : (
            conversations.map((conversation) => (
              <ChatRow
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === activeConversationId}
                projectName={project.name}
                projectPath={project.folderPath}
                running={isConversationRunning(conversation)}
                unread={isConversationUnread(conversation)}
                excerpt={matchExcerpts?.get(conversation.id)}
                onClick={() => void onSelectConversation(conversation.id)}
                onRename={(title) => void onRenameConversation(conversation.id, title)}
                onMarkUnread={() =>
                  void onMarkConversationUnread(conversation.id, conversation.updatedAt)
                }
                onOpenProjectFolder={() => void onOpenProjectFolder(project.id)}
                onDelete={() => void onDeleteConversation(conversation.id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}
