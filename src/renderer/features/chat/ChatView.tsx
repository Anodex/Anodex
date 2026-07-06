import { useChatStore } from '../../stores/chatStore'
import { PageHeader } from '../../components/PageHeader'
import { MessageList } from './MessageList'
import { ChatComposer } from './ChatComposer'
import { ChatEmptyState } from './ChatEmptyState'
import styles from './ChatView.module.css'

/** The chat surface: header, transcript (or empty state), and the composer. */
export function ChatView(): JSX.Element {
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === s.activeId) ?? null)

  return (
    <>
      <PageHeader title={conversation?.title ?? 'Chat'} />
      <div className={styles.body}>
        {conversation && conversation.messages.length > 0 ? (
          <MessageList messages={conversation.messages} />
        ) : (
          <ChatEmptyState />
        )}
        <ChatComposer />
      </div>
    </>
  )
}
