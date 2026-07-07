import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@shared/chat.types'
import { MessageBubble } from './MessageBubble'
import { Icon } from '../../components/Icon'
import { formatClock } from '../../lib/format'
import styles from './MessageList.module.css'

/** Distance (px) from the bottom within which we keep auto-scrolling. */
const STICK_THRESHOLD = 120
const RAIL_TOP_OFFSET = 24
const RAIL_GAP = 14
const RAIL_MAX_WIDTH = 18
const RAIL_MIN_WIDTH = 4
const RAIL_MOUSE_RADIUS = 100

interface UserMarker {
  message: ChatMessage
  top: number
  active: boolean
}

/** Scrollable transcript that follows streaming output unless the user scrolls up. */
export function MessageList({ messages }: { messages: ChatMessage[] }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const stickToBottom = useRef(true)
  const [showJumpButton, setShowJumpButton] = useState(false)
  const [hasNewContent, setHasNewContent] = useState(false)
  const [userMarkers, setUserMarkers] = useState<UserMarker[]>([])

  const updateMarkers = useCallback((): void => {
    const el = containerRef.current
    if (!el) return

    const currentAnchor = el.scrollTop + el.clientHeight * 0.28
    const users = messages.filter((message) => message.role === 'user')
    const entries = users.map((message) => ({
      message,
      offsetTop: messageRefs.current[message.id]?.offsetTop ?? 0
    }))
    let activeId = entries[0]?.message.id
    for (const entry of entries) {
      if (entry.offsetTop <= currentAnchor) activeId = entry.message.id
      else break
    }

    setUserMarkers(
      entries.map(({ message }, index) => ({
        message,
        top: RAIL_TOP_OFFSET + index * RAIL_GAP,
        active: message.id === activeId
      }))
    )
  }, [messages])

  const handleScroll = (): void => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD
    stickToBottom.current = atBottom
    setShowJumpButton(!atBottom)
    if (atBottom) setHasNewContent(false)
    updateMarkers()
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
    window.requestAnimationFrame(updateMarkers)
  }, [messages.length, lastContent, updateMarkers])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    updateMarkers()
    const resizeObserver = new ResizeObserver(updateMarkers)
    resizeObserver.observe(el)
    window.addEventListener('resize', updateMarkers)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', updateMarkers)
    }
  }, [messages, updateMarkers])

  const jumpToBottom = (): void => {
    stickToBottom.current = true
    setShowJumpButton(false)
    setHasNewContent(false)
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }

  const scrollToMessage = (messageId: string): void => {
    const node = messageRefs.current[messageId]
    if (!node) return
    stickToBottom.current = false
    node.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  return (
    <div className={styles.scrollWrap}>
      <div className={styles.scroll} ref={containerRef} onScroll={handleScroll}>
        <div className={styles.inner}>
          {messages.map((message) => (
            <div
              key={message.id}
              ref={(node) => {
                messageRefs.current[message.id] = node
              }}
            >
              <MessageBubble message={message} />
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
      {userMarkers.length > 0 && (
        <UserScrollRail
          markers={userMarkers}
          onSelect={scrollToMessage}
        />
      )}
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

interface UserScrollRailProps {
  markers: UserMarker[]
  onSelect: (messageId: string) => void
}

function UserScrollRail({
  markers,
  onSelect
}: UserScrollRailProps): JSX.Element {
  const [mouseY, setMouseY] = useState<number | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const hoveredMarker = mouseY !== null
    ? markers.reduce((closest, marker) => {
        if (!closest) return marker
        return Math.abs(marker.top - mouseY) < Math.abs(closest.top - mouseY) ? marker : closest
      }, null as UserMarker | null)
    : null

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    setMouseY(e.clientY - rect.top)
  }

  const handlePointerLeave = (): void => {
    setMouseY(null)
  }

  const handleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!hoveredMarker) return
    e.preventDefault()
    onSelect(hoveredMarker.message.id)
  }

  return (
    <div
      className={styles.userRail}
      aria-label="User message quick scroll"
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onClick={handleClick}
    >
      <div className={styles.userRailTrack} />
      {markers.map((marker) => {
        const distance = mouseY !== null ? Math.abs(marker.top - mouseY) : RAIL_MOUSE_RADIUS
        const t = Math.max(0, 1 - distance / RAIL_MOUSE_RADIUS)
        const width = RAIL_MIN_WIDTH + t * (RAIL_MAX_WIDTH - RAIL_MIN_WIDTH)
        return (
          <div
            key={marker.message.id}
            className={`${styles.userRailMarker} ${marker.active ? styles.userRailMarkerActive : ''}`}
            style={{ top: marker.top, width }}
            aria-hidden="true"
          />
        )
      })}
      {hoveredMarker && (
        <div
          ref={previewRef}
          className={styles.userRailPreview}
          style={{ top: hoveredMarker.top }}
        >
          <strong>{previewText(hoveredMarker.message)}</strong>
          <span>{formatClock(hoveredMarker.message.createdAt)}</span>
        </div>
      )}
    </div>
  )
}

function previewText(message: ChatMessage): string {
  const content = message.content.replace(/\s+/g, ' ').trim()
  if (content) return content.length > 72 ? `${content.slice(0, 72)}...` : content
  const attachmentCount = message.attachments?.length ?? 0
  if (attachmentCount === 1) return `Attached ${message.attachments?.[0]?.name ?? 'a file'}`
  if (attachmentCount > 1) return `Attached ${attachmentCount} files`
  return 'Empty message'
}
