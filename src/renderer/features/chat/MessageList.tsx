import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@shared/chat.types'
import { MessageBubble } from './MessageBubble'
import { Icon } from '../../components/Icon'
import styles from './MessageList.module.css'

/** Distance (px) from the bottom within which we keep auto-scrolling. */
const STICK_THRESHOLD = 120

/** Scrollable transcript that follows streaming output unless the user scrolls up. */
export function MessageList({ messages }: { messages: ChatMessage[] }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [showJumpButton, setShowJumpButton] = useState(false)
  const [hasNewContent, setHasNewContent] = useState(false)

  const handleScroll = (): void => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD
    stickToBottom.current = atBottom
    setShowJumpButton(!atBottom)
    if (atBottom) setHasNewContent(false)
  }

  // Re-run as new messages arrive and as the last message grows during streaming.
  const lastContent = messages[messages.length - 1]?.content ?? ''
  useEffect(() => {
    if (stickToBottom.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    } else if (messages.length > 0) {
      // Scrolled away from the bottom while something changed — the jump
      // button alone doesn't say *why* you'd want to use it, so flag that
      // there's actually something new waiting once you do.
      setHasNewContent(true)
    }
  }, [messages.length, lastContent])

  const jumpToBottom = (): void => {
    stickToBottom.current = true
    setShowJumpButton(false)
    setHasNewContent(false)
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }

  return (
    <div className={styles.scrollWrap}>
      <div className={styles.scroll} ref={containerRef} onScroll={handleScroll}>
        <div className={styles.inner}>
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
      {showJumpButton && (
        <button
          type="button"
          className={styles.jumpButton}
          onClick={jumpToBottom}
          aria-label={hasNewContent ? 'Scroll to latest message' : 'Scroll to bottom'}
          title="Scroll to latest"
        >
          <Icon name="chevron-down" size={16} />
          {hasNewContent && <span className={styles.jumpDot} aria-hidden="true" />}
        </button>
      )}
    </div>
  )
}
