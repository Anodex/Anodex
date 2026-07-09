import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@shared/chat.types'
import type { ConversationContext } from '@shared/context.types'
import { CompactionMarker } from './CompactionMarker'
import { MessageBubble } from './MessageBubble'
import { FileTypeIcon } from '../../components/FileTypeIcon'
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
const PREVIEW_HEIGHT = 154

interface UserMarker {
  message: ChatMessage
  top: number
  active: boolean
  responsePreview: string
  editedFiles: string[]
}

/** Scrollable transcript that follows streaming output unless the user scrolls up. */
export function MessageList({
  messages,
  context
}: {
  messages: ChatMessage[]
  context?: ConversationContext | null
}): JSX.Element {
  const compactionThroughId = context?.activeSnapshot?.throughMessageId ?? null
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
    const railHeight = Math.max(1, el.clientHeight - RAIL_TOP_OFFSET * 2)
    const markerGap = entries.length > 1 ? Math.min(RAIL_GAP, railHeight / (entries.length - 1)) : 0
    let activeId = entries[0]?.message.id
    for (const entry of entries) {
      if (entry.offsetTop <= currentAnchor) activeId = entry.message.id
      else break
    }

    setUserMarkers(
      entries.map(({ message }, index) => ({
        message,
        top: RAIL_TOP_OFFSET + index * markerGap,
        active: message.id === activeId,
        ...previewContextForMessage(messages, message)
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
            <div key={message.id}>
              <div
                ref={(node) => {
                  messageRefs.current[message.id] = node
                }}
              >
                <MessageBubble message={message} />
              </div>
              {context?.activeSnapshot && message.id === compactionThroughId && (
                <CompactionMarker snapshot={context.activeSnapshot} />
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
      {userMarkers.length > 0 && (
        <UserScrollRail markers={userMarkers} onSelect={scrollToMessage} />
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

function UserScrollRail({ markers, onSelect }: UserScrollRailProps): JSX.Element {
  const railRef = useRef<HTMLDivElement>(null)
  const [mouseY, setMouseY] = useState<number | null>(null)
  const hoveredMarker =
    mouseY !== null
      ? markers.reduce(
          (closest, marker) => {
            if (!closest) return marker
            return Math.abs(marker.top - mouseY) < Math.abs(closest.top - mouseY) ? marker : closest
          },
          null as UserMarker | null
        )
      : null
  const railHeight = railRef.current?.clientHeight ?? window.innerHeight
  const previewTop = hoveredMarker
    ? Math.max(
        PREVIEW_HEIGHT / 2 + 8,
        Math.min(hoveredMarker.top, railHeight - PREVIEW_HEIGHT / 2 - 8)
      )
    : 0

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

  const selectMarker = (messageId: string): void => {
    onSelect(messageId)
    setMouseY(null)
  }

  return (
    <div
      ref={railRef}
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
        const isHovered = hoveredMarker?.message.id === marker.message.id
        const markerClass = [
          styles.userRailMarker,
          marker.active ? styles.userRailMarkerActive : '',
          isHovered && !marker.active ? styles.userRailMarkerHovered : ''
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <button
            key={marker.message.id}
            type="button"
            className={markerClass}
            style={{ top: marker.top, width }}
            onClick={(event) => {
              event.stopPropagation()
              selectMarker(marker.message.id)
            }}
            onFocus={() => setMouseY(marker.top)}
            onBlur={() => setMouseY(null)}
            aria-label={`Scroll to your message from ${formatClock(marker.message.createdAt)}`}
          />
        )
      })}
      {hoveredMarker && (
        <div className={styles.userRailPreview} style={{ top: previewTop }}>
          <strong>{previewText(hoveredMarker.message, 84)}</strong>
          {hoveredMarker.responsePreview && (
            <p className={styles.userRailResponse}>{hoveredMarker.responsePreview}</p>
          )}
          <div className={styles.userRailMeta}>
            <span>{formatClock(hoveredMarker.message.createdAt)}</span>
            {hoveredMarker.editedFiles.length > 0 && (
              <div className={styles.userRailFiles} aria-label="Edited files">
                {hoveredMarker.editedFiles.slice(0, 2).map((file) => (
                  <span key={file} className={styles.userRailFile} title={file}>
                    <FileTypeIcon fileName={file} size={13} />
                    <span>{fileName(file)}</span>
                  </span>
                ))}
                {hoveredMarker.editedFiles.length > 2 && (
                  <span className={styles.userRailMore}>
                    +{hoveredMarker.editedFiles.length - 2}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function previewContextForMessage(
  messages: ChatMessage[],
  userMessage: ChatMessage
): Pick<UserMarker, 'responsePreview' | 'editedFiles'> {
  const startIndex = messages.findIndex((message) => message.id === userMessage.id)
  const following = startIndex >= 0 ? messages.slice(startIndex + 1) : []
  const replyMessages = []
  for (const message of following) {
    if (message.role === 'user') break
    if (message.role === 'assistant') replyMessages.push(message)
  }

  const responsePreview = previewText(
    replyMessages.find((message) => message.content)?.content ?? '',
    128
  )
  const editedFiles = Array.from(
    new Set(
      replyMessages.flatMap((message) =>
        (message.toolCalls ?? [])
          .map((call) => call.diff?.path)
          .filter((path): path is string => Boolean(path))
      )
    )
  )

  return { responsePreview, editedFiles }
}

function previewText(messageOrText: ChatMessage | string, maxLength = 72): string {
  if (typeof messageOrText === 'string') {
    const content = messageOrText.replace(/\s+/g, ' ').trim()
    if (!content) return ''
    return content.length > maxLength ? `${content.slice(0, maxLength)}...` : content
  }

  const message = messageOrText
  const content = message.content.replace(/\s+/g, ' ').trim()
  if (content) return content.length > maxLength ? `${content.slice(0, maxLength)}...` : content
  const attachmentCount = message.attachments?.length ?? 0
  if (attachmentCount === 1) return `Attached ${message.attachments?.[0]?.name ?? 'a file'}`
  if (attachmentCount > 1) return `Attached ${attachmentCount} files`
  return 'Empty message'
}

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}
