import { useEffect, useRef } from 'react'
import type { ChatMessage } from '@shared/chat.types'
import { MessageBubble } from './MessageBubble'
import styles from './MessageList.module.css'

/** Distance (px) from the bottom within which we keep auto-scrolling. */
const STICK_THRESHOLD = 120

/** Scrollable transcript that follows streaming output unless the user scrolls up. */
export function MessageList({ messages }: { messages: ChatMessage[] }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  const handleScroll = (): void => {
    const el = containerRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD
  }

  // Re-run as new messages arrive and as the last message grows during streaming.
  const lastContent = messages[messages.length - 1]?.content ?? ''
  useEffect(() => {
    if (stickToBottom.current) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, lastContent])

  return (
    <div className={styles.scroll} ref={containerRef} onScroll={handleScroll}>
      <div className={styles.inner}>
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
