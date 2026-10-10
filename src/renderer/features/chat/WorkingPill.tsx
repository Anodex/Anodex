import { useEffect, useState } from 'react'
import { StatusDot } from '../../components/ui/StatusDot'
import { formatElapsedClock } from '../../lib/format'
import { useChatStore } from '../../stores/chatStore'
import styles from './WorkingPill.module.css'

/**
 * "Working · 0:29" in the chat header while the open chat's reply is running.
 *
 * The "Working for" line sits at the top of the running turn, so in a long
 * reply, or scrolled back up through the chat, it is off screen and nothing
 * visible says the chat is still busy. This keeps that in view.
 *
 * Its own component with its own one-second tick, apart from the transcript,
 * so the clock redraws this pill and nothing else. The selector returns a
 * number, so streamed tokens do not re-render it either.
 */
export function WorkingPill(): JSX.Element | null {
  const startedAt = useChatStore((s) => {
    const messages = s.conversations.find((c) => c.id === s.activeId)?.messages
    if (!messages) return null
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].streaming) return messages[index].createdAt
    }
    return null
  })
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (startedAt === null) return
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [startedAt])

  if (startedAt === null) return null
  const elapsed = formatElapsedClock(now - startedAt)
  return (
    <span
      className={styles.pill}
      role="status"
      aria-label="Working"
      title={`Working for ${elapsed}`}
    >
      <StatusDot tone="running" />
      Working · <span className={styles.clock}>{elapsed}</span>
    </span>
  )
}
