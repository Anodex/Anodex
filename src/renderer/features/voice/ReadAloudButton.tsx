import { useEffect, useState, useSyncExternalStore } from 'react'
import { Icon } from '../../components/Icon'
import { VOICE_NAME } from './voiceIdentity'
import { readAloudState, subscribe, toggleReadAloud, voiceReady } from './readAloud'

/**
 * The control that reads a finished reply out loud.
 *
 * It renders nothing at all when this build cannot speak, which is what lets the
 * chat carry one unconditional line instead of a condition: the question of
 * whether voice exists is answered inside voice, and removing the feature means
 * deleting a directory and one marked line.
 *
 * The label changes with what is happening rather than staying "Read aloud",
 * because the wait before the first word is long enough — a couple of seconds a
 * sentence — that a button which looks unchanged looks broken.
 */
export function ReadAloudButton({
  token,
  text,
  className
}: {
  /** The message this reads. Identity, so two bubbles never share a state. */
  token: string
  text: string
  /** Supplied by the chat, so the button matches the row it sits in. */
  className?: string
}): JSX.Element | null {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let alive = true
    void voiceReady().then((ready) => {
      if (alive) setAvailable(ready)
    })
    return () => {
      alive = false
    }
  }, [])

  const state = useSyncExternalStore(subscribe, readAloudState)
  const mine = state?.token === token ? state : null

  if (!available || !text.trim()) return null

  const label =
    mine?.phase === 'preparing'
      ? mine.total > 0
        ? `${VOICE_NAME} ${mine.sentence}/${mine.total}`
        : VOICE_NAME
      : mine?.phase === 'playing'
        ? 'Pause'
        : mine?.phase === 'paused'
          ? 'Resume'
          : 'Listen'

  return (
    <button
      type="button"
      className={className}
      onClick={() => toggleReadAloud(token, text)}
      aria-label={
        mine?.phase === 'preparing'
          ? 'Stop getting this reply ready'
          : mine?.phase === 'playing'
            ? 'Pause reading this reply'
            : mine?.phase === 'paused'
              ? 'Carry on reading this reply'
              : 'Read this reply aloud'
      }
      title={
        mine?.phase === 'preparing'
          ? `${VOICE_NAME} is getting ready — click to stop`
          : mine
            ? `${VOICE_NAME} is reading this reply`
            : `Have ${VOICE_NAME} read this reply aloud`
      }
    >
      <Icon
        name={
          mine?.phase === 'preparing' ? 'stop' : mine?.phase === 'playing' ? 'pause' : 'speaker'
        }
        size={12}
      />
      {label}
    </button>
  )
}
