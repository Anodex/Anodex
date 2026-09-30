import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useUiStore } from '../stores/uiStore'
import { Icon, type IconName } from './Icon'
import { Spinner } from './ui/Spinner'
import type { Toast } from '../stores/uiStore'
import styles from './Toasts.module.css'

const ICON_BY_KIND: Record<Exclude<Toast['kind'], 'pending'>, IconName> = {
  info: 'info',
  success: 'check',
  error: 'alert'
}

/** How far each toast behind the front one peeks out above it. */
const PEEK_PX = 10
/** Space between toasts once the stack fans out. */
const GAP_PX = 8
/** Toasts drawn behind the front one; any further back fade out entirely. */
const MAX_BEHIND = 2
/** Matches the exit animation in Toasts.module.css. */
const EXIT_MS = 220

interface Leaving {
  toast: Toast
  transform: string
}

/**
 * The toast stack, bottom right.
 *
 * Toasts deal onto a deck: the newest in front, two older ones peeking out
 * behind it, so a burst of notifications takes the room of one. Hovering or
 * focusing the deck fans it out to read, and holds every countdown (the bar
 * along each toast's foot) until the pointer leaves.
 *
 * Every toast is absolutely placed and moved by transform, so arrivals,
 * departures, and fanning out all animate rather than jump. A dismissed toast
 * has already left the store; it is kept here for the length of its exit
 * animation, at the place it was last drawn, so it can slide away while the
 * rest close up behind it.
 */
export function Toasts(): JSX.Element {
  const toasts = useUiStore((s) => s.toasts)
  const dismiss = useUiStore((s) => s.dismissToast)
  const hold = useUiStore((s) => s.holdToasts)

  const [expanded, setExpanded] = useState(false)
  const [heights, setHeights] = useState<Record<string, number>>({})
  const [leaving, setLeaving] = useState<Leaving[]>([])
  const contentRefs = useRef(new Map<string, HTMLDivElement>())
  const lastTransform = useRef(new Map<string, string>())
  const previous = useRef<Toast[]>([])

  // Newest first: index 0 is the front of the deck.
  const ordered = [...toasts].reverse()

  useEffect(() => hold(expanded), [expanded, hold])

  // An empty stack has nothing left to read, so it cannot stay held open.
  useEffect(() => {
    if (toasts.length === 0) setExpanded(false)
  }, [toasts.length])

  useEffect(() => {
    const gone = previous.current.filter((p) => !toasts.some((t) => t.id === p.id))
    previous.current = toasts
    if (gone.length === 0) return
    setLeaving((current) => [
      ...current,
      ...gone.map((toast) => ({
        toast,
        transform: lastTransform.current.get(toast.id) ?? 'none'
      }))
    ])
    const timer = window.setTimeout(() => {
      setLeaving((current) => current.filter((l) => !gone.includes(l.toast)))
      for (const toast of gone) lastTransform.current.delete(toast.id)
    }, EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [toasts])

  // Natural heights, so a fanned-out stack spaces each toast by its real size
  // and a collapsed one can clip the toasts behind to the front one's height.
  useLayoutEffect(() => {
    const next: Record<string, number> = {}
    let changed = false
    for (const toast of toasts) {
      const height = contentRefs.current.get(toast.id)?.offsetHeight ?? 0
      next[toast.id] = height
      if (heights[toast.id] !== height) changed = true
    }
    if (changed || Object.keys(heights).length !== toasts.length) setHeights(next)
  }, [heights, toasts])

  const frontHeight = heights[ordered[0]?.id] ?? 0
  let offset = 0
  const placed = ordered.map((toast, depth) => {
    const height = heights[toast.id] ?? frontHeight
    let transform: string
    let opacity = 1
    if (expanded) {
      transform = `translateY(${-offset}px)`
      offset += height + GAP_PX
    } else {
      const scale = 1 - depth * 0.05
      transform = `translateY(${-depth * PEEK_PX}px) scale(${scale})`
      opacity = depth > MAX_BEHIND ? 0 : 1 - depth * 0.18
    }
    lastTransform.current.set(toast.id, transform)
    return { toast, depth, transform, opacity }
  })

  const stackHeight = expanded
    ? Math.max(0, offset - GAP_PX)
    : frontHeight + Math.min(ordered.length - 1, MAX_BEHIND) * PEEK_PX

  return (
    <div
      className={`${styles.stack} ${expanded ? styles.expanded : ''}`}
      style={{ height: stackHeight }}
      role="region"
      aria-label="Notifications"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false)
      }}
    >
      <div role="status" aria-live="polite">
        {placed.map(({ toast, depth, transform, opacity }) => (
          <div
            key={toast.id}
            className={styles.slot}
            style={{
              transform,
              opacity,
              zIndex: ordered.length - depth,
              // Behind the front one, a collapsed toast shows only the edge that peeks out.
              height: !expanded && depth > 0 ? frontHeight : undefined
            }}
            aria-hidden={!expanded && depth > 0 ? true : undefined}
          >
            <ToastCard
              toast={toast}
              onDismiss={() => dismiss(toast.id)}
              contentRef={(node) => {
                if (node) contentRefs.current.set(toast.id, node)
                else contentRefs.current.delete(toast.id)
              }}
            />
          </div>
        ))}
      </div>
      {leaving.map(({ toast, transform }) => (
        <div key={`leaving-${toast.id}`} className={styles.slot} style={{ transform }} aria-hidden>
          <ToastCard toast={toast} leaving onDismiss={() => {}} />
        </div>
      ))}
    </div>
  )
}

function ToastCard({
  toast,
  leaving = false,
  onDismiss,
  contentRef
}: {
  toast: Toast
  leaving?: boolean
  onDismiss: () => void
  contentRef?: (node: HTMLDivElement | null) => void
}): JSX.Element {
  return (
    <div
      ref={contentRef}
      className={`${styles.toast} ${styles[toast.kind]} ${leaving ? styles.leaving : ''}`}
    >
      <span className={styles.icon}>
        {toast.kind === 'pending' ? (
          <Spinner size={14} />
        ) : (
          <Icon name={ICON_BY_KIND[toast.kind]} size={15} />
        )}
      </span>
      <div className={styles.body}>
        <div className={styles.title}>
          {toast.title}
          {(toast.count ?? 1) > 1 && (
            <span key={toast.count} className={styles.count}>
              ×{toast.count}
            </span>
          )}
        </div>
        {toast.message && <div className={styles.message}>{toast.message}</div>}
      </div>
      <button
        type="button"
        className={styles.close}
        onClick={onDismiss}
        aria-label="Dismiss notification"
        tabIndex={leaving ? -1 : undefined}
      >
        <Icon name="close" size={14} />
      </button>
      {toast.duration && toast.kind !== 'pending' && (
        <span
          key={toast.shownAt}
          className={styles.countdown}
          style={{ animationDuration: `${toast.duration}ms` }}
        />
      )}
    </div>
  )
}
