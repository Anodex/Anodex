import { useEffect, useState } from 'react'
import type { ChatPersonality, PersonalityTint } from '@shared/chatPersonality'
import { loadAttachmentImage } from '../../features/chat/loadAttachmentImage'
import { personalityDisplayName, personalityInitials } from './personalityIdentity'
import styles from './PersonalityAvatar.module.css'

/**
 * A personality's face: their picture, or a tinted monogram of their name.
 *
 * The picture is stored as a path, never as image data (see `ChatPersonality.image`),
 * so it is read from disk here the same way a chat attachment is. A read that
 * fails falls back to the monogram rather than leaving a blank tile — a moved
 * or deleted file should cost the picture, not the identity.
 */

const TINT_VAR: Record<PersonalityTint, string> = {
  accent: 'var(--accent)',
  violet: 'var(--accent-violet)',
  green: 'var(--accent-green)',
  'series-1': 'var(--series-1)',
  'series-2': 'var(--series-2)',
  'series-3': 'var(--series-3)',
  'series-4': 'var(--series-4)'
}

export function PersonalityAvatar({
  personality,
  size,
  className
}: {
  personality: Pick<ChatPersonality, 'name' | 'image' | 'tint'>
  size: number
  className?: string
}): JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const imagePath = personality.image

  useEffect(() => {
    if (!imagePath) {
      setDataUrl(null)
      return undefined
    }
    let cancelled = false
    void loadAttachmentImage(imagePath).then((url) => {
      if (!cancelled) setDataUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [imagePath])

  const name = personalityDisplayName(personality)

  return (
    <span
      className={`${styles.avatar} ${className ?? ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.36)),
        borderRadius: Math.max(4, Math.round(size * 0.22)),
        background: TINT_VAR[personality.tint ?? 'accent']
      }}
      aria-hidden="true"
      title={name}
    >
      {dataUrl ? <img src={dataUrl} alt="" className={styles.image} /> : personalityInitials(name)}
    </span>
  )
}
