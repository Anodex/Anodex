import { useEffect, useState } from 'react'
import { contextCompactionHistory, type ConversationContextSnapshot } from '@shared/context.types'
import { useChatStore } from '../../stores/chatStore'
import { getActiveProject, useProjectStore } from '../../stores/projectStore'
import { PageHeader } from '../../components/PageHeader'
import { MessageList } from './MessageList'
import { ChatBackground } from './ChatBackground'
import { ChatComposer } from './ChatComposer'
import { ChatEmptyState } from './ChatEmptyState'
import { ContextHistoryMenu } from './ContextHistoryMenu'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  normalizeSpeechText,
  speechReady,
  subscribeReadiness,
  toggleReadAloud
} from '../voice/readAloud'
import styles from './ChatView.module.css'

/** The chat surface: header, transcript (or empty state), and the composer. */
export function ChatView(): JSX.Element {
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === s.activeId) ?? null)
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeProject = getActiveProject(projects, activeProjectId)
  const speechEnabled = useSettingsStore((state) => state.settings?.speech.enabled === true)
  const [speechAvailable, setSpeechAvailable] = useState(false)
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void speechReady().then((ready) => {
        if (alive) setSpeechAvailable(ready)
      })
    }
    refresh()
    const unsubscribe = subscribeReadiness(refresh)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])
  const setAutoRead = useChatStore((state) => state.setReadRepliesAutomatically)
  const [selection, setSelection] = useState('')
  useEffect(() => {
    const refreshSelection = (): void =>
      setSelection(window.getSelection()?.toString().trim() ?? '')
    document.addEventListener('selectionchange', refreshSelection)
    return () => document.removeEventListener('selectionchange', refreshSelection)
  }, [])
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
          <>
            {speechEnabled && speechAvailable && conversation && (
              <>
                <button
                  type="button"
                  className={styles.headerAction}
                  disabled={!selection}
                  onClick={() => {
                    const spoken = normalizeSpeechText(selection)
                    if (spoken) toggleReadAloud(`selection-${conversation.id}`, spoken)
                  }}
                >
                  Read selection
                </button>
                <label className={styles.autoRead}>
                  <input
                    type="checkbox"
                    checked={conversation.readRepliesAutomatically === true}
                    onChange={(event) => void setAutoRead(event.currentTarget.checked)}
                  />
                  Read replies automatically
                </label>
              </>
            )}
            {snapshots.length > 0 && (
              <ContextHistoryMenu snapshots={snapshots} onSelect={revealCompactedContext} />
            )}
          </>
        }
      />
      <div className={styles.body}>
        {conversation?.messagesNotLoaded ? (
          // Opened, its messages still being read: the empty-chat greeting here
          // would say a conversation with history has none.
          <ChatBackground />
        ) : conversation && conversation.messages.length > 0 ? (
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
