import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage } from '@shared/chat.types'
import type { ConversationContext } from '@shared/context.types'
import { CompactionMarker } from './CompactionMarker'
import { MessageBubble } from './MessageBubble'
import { FileTypeIcon } from '../../components/FileTypeIcon'
import { Icon } from '../../components/Icon'
import { formatClock } from '../../lib/format'
import { findLatestUserRequest, shouldPinCurrentRequest } from './messageTimeline'
import { visualComparisonsByMessage } from './visualComparisonPair'
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
  // Messages are only ever appended, so the streaming reply (if any) is
  // always last — no need to scan the whole conversation for it, and doing
  // it once here (instead of inside every MessageBubble) avoids an
  // O(bubbles × messages) rescan on every streamed token.
  const conversationStreaming = messages[messages.length - 1]?.streaming ?? false
  const visualComparisons = useMemo(() => visualComparisonsByMessage(messages), [messages])
  // The conversation's first assistant turn is the only one eligible for the
  // one-shot "first light" arrival; the bubble itself decides whether it is
  // actually witnessing that reply stream in live.
  const firstAssistantId = messages.find((m) => m.role === 'assistant')?.id ?? null
  const containerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const stickToBottom = useRef(true)
  /** Last observed transcript height, so a viewport change isn't mistaken for new content. */
  const lastInnerHeight = useRef(0)
  /** True while our own smooth jump is animating, so its frames aren't read as user intent. */
  const animatingToBottom = useRef(false)
  // Read inside updateMarkers instead of closing over `messages` directly, so
  // the callback's identity stays stable across streaming re-renders — a
  // stable `updateMarkers` keeps the ResizeObserver effect below from
  // disconnecting and reconnecting on every streamed token.
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const [showJumpButton, setShowJumpButton] = useState(false)
  const [hasNewContent, setHasNewContent] = useState(false)
  const [userMarkers, setUserMarkers] = useState<UserMarker[]>([])
  const [pinnedRequest, setPinnedRequest] = useState<UserMarker | null>(null)

  const updateMarkers = useCallback((): void => {
    const el = containerRef.current
    if (!el) return

    const currentMessages = messagesRef.current
    const currentAnchor = el.scrollTop + el.clientHeight * 0.28
    const users = currentMessages.filter((message) => message.role === 'user')
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

    const markers = entries.map(({ message }, index) => ({
      message,
      top: RAIL_TOP_OFFSET + index * markerGap,
      active: message.id === activeId,
      ...previewContextForMessage(currentMessages, message)
    }))

    setUserMarkers(markers)

    // The rail's active marker follows the section nearest the scroll anchor,
    // but "Current request" must always mean the newest user turn. Keeping
    // those concepts separate prevents an older prompt from staying pinned
    // after the user sends a follow-up lower in the transcript.
    const currentRequest = findLatestUserRequest(currentMessages)
    const currentEntry = entries.find((entry) => entry.message.id === currentRequest?.id)
    const currentMarker = markers.find((marker) => marker.message.id === currentRequest?.id) ?? null
    setPinnedRequest(
      currentEntry &&
        currentMarker &&
        shouldPinCurrentRequest({ messageTop: currentEntry.offsetTop, scrollTop: el.scrollTop })
        ? currentMarker
        : null
    )
  }, [])

  /**
   * Scroll to the exact bottom of our own container.
   *
   * Deliberately not `scrollIntoView` on a trailing marker: that stops at the
   * marker, leaving `.inner`'s bottom padding below the fold, so every
   * "follow the stream" scroll landed short of the real bottom and the next
   * scroll event measured a gap that wasn't the user's doing. It can also
   * scroll ancestor containers, which is never what we want here.
   */
  const scrollToBottomNow = useCallback((behavior: ScrollBehavior = 'auto'): void => {
    const el = containerRef.current
    if (!el) return
    const animate =
      behavior === 'smooth' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (animate) animatingToBottom.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: animate ? 'smooth' : 'auto' })
  }, [])

  /**
   * Refresh the jump button from live geometry. Read on every scroll *and*
   * every resize, because the transcript viewport shrinks whenever the
   * composer grows a line — a geometry change that moves the bottom without
   * ever firing a scroll event.
   */
  const measure = useCallback((): void => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD
    setShowJumpButton(!atBottom)
    if (atBottom) setHasNewContent(false)
  }, [])

  const handleScroll = (): void => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD

    // Every frame of our own smooth jump arrives here as a scroll event. Read
    // as user intent they'd un-stick the view and flash the jump button back
    // on for the length of the animation, so only its arrival counts.
    if (animatingToBottom.current) {
      if (atBottom) animatingToBottom.current = false
      updateMarkers()
      return
    }

    // A scroll is the only thing that changes stick *intent* — resizes and
    // streamed content must never silently opt the user back in or out.
    stickToBottom.current = atBottom
    measure()
    updateMarkers()
  }

  useEffect(() => {
    const el = containerRef.current
    const inner = innerRef.current
    if (!el || !inner) return

    /** The transcript itself changed height: follow it, or flag what's waiting. */
    const onContentResize = (): void => {
      const grew = inner.offsetHeight > lastInnerHeight.current
      lastInnerHeight.current = inner.offsetHeight
      if (stickToBottom.current) {
        scrollToBottomNow()
      } else if (grew) {
        // Scrolled away from the bottom while something new arrived — the jump
        // button alone doesn't say *why* you'd want to use it.
        setHasNewContent(true)
      }
      measure()
      updateMarkers()
    }

    /** The viewport changed height (composer grew, window resized, dock opened). */
    const onViewportResize = (): void => {
      if (stickToBottom.current) scrollToBottomNow()
      measure()
      updateMarkers()
    }

    // Observing `.inner` is what makes following the stream reliable. Keying
    // it to the last message's text missed every other way a turn grows —
    // tool cards filling in, images finishing load, a recap expanding — and
    // during a tool-heavy turn that drift is what silently broke autoscroll:
    // the gap crept past STICK_THRESHOLD and the next scroll event latched
    // stickToBottom to false for the rest of the turn.
    const contentObserver = new ResizeObserver(onContentResize)
    contentObserver.observe(inner)
    const viewportObserver = new ResizeObserver(onViewportResize)
    viewportObserver.observe(el)
    window.addEventListener('resize', onViewportResize)

    // Taking over mid-animation has to hand control straight back, otherwise
    // an interrupted jump never reaches the bottom, the guard above never
    // clears, and every later scroll is discarded as animation noise.
    const abandonAnimation = (): void => {
      animatingToBottom.current = false
    }
    el.addEventListener('wheel', abandonAnimation, { passive: true })
    el.addEventListener('touchstart', abandonAnimation, { passive: true })
    el.addEventListener('pointerdown', abandonAnimation)
    el.addEventListener('keydown', abandonAnimation)

    return () => {
      contentObserver.disconnect()
      viewportObserver.disconnect()
      window.removeEventListener('resize', onViewportResize)
      el.removeEventListener('wheel', abandonAnimation)
      el.removeEventListener('touchstart', abandonAnimation)
      el.removeEventListener('pointerdown', abandonAnimation)
      el.removeEventListener('keydown', abandonAnimation)
    }
  }, [measure, scrollToBottomNow, updateMarkers])

  // New messages also shift the rail's markers, which resizing alone may not
  // change (a reply that replaces an equally tall placeholder).
  useEffect(() => {
    window.requestAnimationFrame(updateMarkers)
  }, [messages.length, updateMarkers])

  const jumpToBottom = (): void => {
    stickToBottom.current = true
    setShowJumpButton(false)
    setHasNewContent(false)
    scrollToBottomNow('smooth')
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
        <div className={styles.inner} ref={innerRef}>
          {messages.map((message, index) => (
            <div key={message.id}>
              {(index === 0 ||
                !isSameCalendarDay(messages[index - 1].createdAt, message.createdAt)) && (
                <div className={styles.dayDivider}>{formatDayLabel(message.createdAt)}</div>
              )}
              <div
                ref={(node) => {
                  messageRefs.current[message.id] = node
                }}
              >
                <MessageBubble
                  message={message}
                  previousUserContent={findPreviousUserContent(messages, index)}
                  conversationStreaming={conversationStreaming}
                  firstLight={message.id === firstAssistantId}
                  visualComparison={visualComparisons.get(message.id) ?? null}
                />
              </div>
              {context?.activeSnapshot && message.id === compactionThroughId && (
                <CompactionMarker snapshot={context.activeSnapshot} />
              )}
            </div>
          ))}
        </div>
      </div>
      {pinnedRequest && (
        <button
          type="button"
          className={styles.currentRequest}
          onClick={() => scrollToMessage(pinnedRequest.message.id)}
          title="Jump to current request"
        >
          <span className={styles.currentRequestLabel}>Current request</span>
          <span className={styles.currentRequestText}>
            {previewText(pinnedRequest.message, 132)}
          </span>
        </button>
      )}
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

function isSameCalendarDay(a: number, b: number): boolean {
  const dateA = new Date(a)
  const dateB = new Date(b)
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  )
}

/** "Today", "Yesterday", or a short local date for older days. */
function formatDayLabel(timestamp: number): string {
  const now = Date.now()
  if (isSameCalendarDay(timestamp, now)) return 'Today'
  if (isSameCalendarDay(timestamp, now - 24 * 60 * 60 * 1000)) return 'Yesterday'
  const date = new Date(timestamp)
  return date.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {})
  })
}

function findPreviousUserContent(messages: ChatMessage[], index: number): string | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role === 'user' && message.content.trim()) return message.content
  }
  return undefined
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
