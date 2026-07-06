import { useState } from 'react'
import type { Project } from '@shared/project.types'
import type { Conversation } from '@shared/conversation.types'
import { Icon } from '../Icon'
import { ChatRow } from './ChatRow'
import { ProjectActionsMenu } from './ProjectActionsMenu'
import sidebarStyles from '../Sidebar.module.css'
import styles from './ProjectRow.module.css'

interface ProjectRowProps {
  project: Project
  conversations: Conversation[]
  active: boolean
  expanded: boolean
  activeConversationId: string | null
  onToggle: () => void
  onNewChat: (projectId: string) => void
  onSelectConversation: (conversationId: string) => void
  onDeleteConversation: (conversationId: string) => void
  onRename: (project: Project, name: string) => void
  onDelete: (project: Project) => void
}

/** A project row with expand/collapse, new-chat action, and its chat list. */
export function ProjectRow({
  project,
  conversations,
  active,
  expanded,
  activeConversationId,
  onToggle,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  onRename,
  onDelete
}: ProjectRowProps): JSX.Element {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className={`${styles.project} ${active ? styles.projectActive : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={styles.header}>
        <button type="button" className={styles.toggle} onClick={onToggle} title={project.name}>
          <Icon
            name="chevron-down"
            size={12}
            className={`${styles.chevron} ${expanded ? '' : styles.chevronCollapsed}`}
          />
          <span className={styles.name}>{project.name}</span>
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
          <ProjectActionsMenu project={project} onRename={onRename} onDelete={onDelete} />
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
                onClick={() => void onSelectConversation(conversation.id)}
                action={
                  <button
                    type="button"
                    className={sidebarStyles.chatDelete}
                    onClick={(event) => {
                      event.stopPropagation()
                      void onDeleteConversation(conversation.id)
                    }}
                    aria-label="Delete chat"
                    title="Delete chat"
                  >
                    <Icon name="trash" size={12} />
                  </button>
                }
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}
