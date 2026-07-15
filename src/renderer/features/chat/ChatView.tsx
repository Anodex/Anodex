import { useChatStore } from '../../stores/chatStore'
import { getActiveProject, useProjectStore } from '../../stores/projectStore'
import { PageHeader } from '../../components/PageHeader'
import { MessageList } from './MessageList'
import { ChatComposer } from './ChatComposer'
import { ChatConstellation } from './ChatConstellation'
import { ChatEmptyState } from './ChatEmptyState'
import styles from './ChatView.module.css'

/** The chat surface: header, transcript (or empty state), and the composer. */
export function ChatView(): JSX.Element {
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === s.activeId) ?? null)
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeProject = getActiveProject(projects, activeProjectId)

  return (
    <>
      <PageHeader title={conversation?.title ?? 'Chat'} eyebrow={activeProject?.name} />
      <div className={styles.body}>
        {conversation && conversation.messages.length > 0 ? (
          <MessageList messages={conversation.messages} context={conversation.context} />
        ) : (
          <>
            {/* Mounted on .body, not inside the empty state, so the scene
                fills the full panel — including behind the composer. */}
            <ChatConstellation />
            <ChatEmptyState />
          </>
        )}
        <ChatComposer />
      </div>
    </>
  )
}
