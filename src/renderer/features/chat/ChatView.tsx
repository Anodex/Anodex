import { useState } from 'react'
import { contextCompactionHistory, type ConversationContextSnapshot } from '@shared/context.types'
import { useChatStore } from '../../stores/chatStore'
import { getActiveProject, useProjectStore } from '../../stores/projectStore'
import { PageHeader } from '../../components/PageHeader'
import { MessageList } from './MessageList'
import { ChatBackground } from './ChatBackground'
import { ChatComposer } from './ChatComposer'
import { ChatEmptyState } from './ChatEmptyState'
import { ContextHistoryMenu } from './ContextHistoryMenu'
import styles from './ChatView.module.css'

/** The chat surface: header, transcript (or empty state), and the composer. */
export function ChatView(): JSX.Element {
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === s.activeId) ?? null)
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeProject = getActiveProject(projects, activeProjectId)
  const [compactionReveal, setCompactionReveal] = useState<{
    conversationId: string
    snapshotId: string
    request: number
  } | null>(null)
  const snapshots = contextCompactionHistory(conversation?.context)

  const revealCompactedContext = (snapshot: ConversationContextSnapshot): void => {
    if (!conversation) return
    setCompactionReveal((current) => ({
      conversationId: conversation.id,
      snapshotId: snapshot.id,
      request:
        current?.conversationId === conversation.id && current.snapshotId === snapshot.id
          ? current.request + 1
          : 1
    }))
  }

  return (
    <>
      <PageHeader
        title={conversation?.title ?? 'Chat'}
        eyebrow={activeProject?.name}
        actions={
          snapshots.length > 0 ? (
            <ContextHistoryMenu snapshots={snapshots} onSelect={revealCompactedContext} />
          ) : undefined
        }
      />
      <div className={styles.body}>
        {conversation && conversation.messages.length > 0 ? (
          <MessageList
            messages={conversation.messages}
            context={conversation.context}
            compactionReveal={
              compactionReveal?.conversationId === conversation.id ? compactionReveal : null
            }
          />
        ) : (
          <>
            {/* Mounted on .body, not inside the empty state, so the scene
                fills the full panel — including behind the composer. */}
            <ChatBackground />
            <ChatEmptyState />
          </>
        )}
        <ChatComposer />
      </div>
    </>
  )
}
