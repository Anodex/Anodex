import { useEffect, useState, useSyncExternalStore } from 'react'
import { Icon } from '../../components/Icon'
import {
  speechReady,
  readAloudState,
  subscribe,
  toggleReadAloud,
  stopReadAloud,
  normalizeSpeechText,
  subscribeReadiness
} from './readAloud'
import styles from './ReadAloudButton.module.css'

export function ReadAloudButton({
  token,
  text
}: {
  token: string
  text: string
}): JSX.Element | null {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void speechReady().then((ready) => {
        if (alive) setAvailable(ready)
      })
    }
    refresh()
    const unsubscribe = subscribeReadiness(refresh)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])
  const state = useSyncExternalStore(subscribe, readAloudState)
  const mine = state?.token === token ? state : null
  const spokenText = normalizeSpeechText(text)
  if (!available || !spokenText) return null
  const label =
    mine?.phase === 'preparing'
      ? 'Preparing'
      : mine?.phase === 'playing'
        ? 'Pause'
        : mine?.phase === 'paused'
          ? 'Resume'
          : 'Listen'
  return (
    <>
      <button
        type="button"
        className={styles.button}
        onClick={() => toggleReadAloud(token, spokenText)}
        aria-label={`${label} reply aloud`}
      >
        <Icon name={mine?.phase === 'playing' ? 'pause' : 'speaker'} size={12} />
        {label}
      </button>
      {mine && (
        <button
          type="button"
          className={styles.button}
          onClick={stopReadAloud}
          aria-label="Stop read aloud"
        >
          <Icon name="stop" size={12} />
          Stop
        </button>
      )}
    </>
  )
}
