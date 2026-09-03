import { useEffect, useState } from 'react'
import type { ChatPersonality, PersonalityTint } from '@shared/chatPersonality'
import { loadAttachmentImage } from '../../features/chat/loadAttachmentImage'
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

/** Word characters only: "Rook (mine)" must read RM, not "R(". */
export function personalityInitials(name: string): string {
  const parts = (name.trim() || 'Untitled').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/** An unnamed personality still has to render somewhere, including in chat. */
export function personalityDisplayName(personality: Pick<ChatPersonality, 'name'>): string {
  return personality.name.trim() || 'Untitled'
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
