import { useEffect, useState } from 'react'
import type { ChatPersonality, PersonalityTint } from '@shared/chatPersonality'
import { ANODEX_PERSONALITY_ID } from '@shared/chatPersonality'
import appIcon from '../../assets/app-icon.png'
import valeIcon from '../../assets/personalities/vale.png'
import wrenIcon from '../../assets/personalities/wren.png'
import cassIcon from '../../assets/personalities/cass.png'
import junoIcon from '../../assets/personalities/juno.png'
import rookIcon from '../../assets/personalities/rook.png'
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

/**
 * The shipped face for each built-in.
 *
 * Keyed off the identity rather than a stored path, so these cannot be
 * replaced, and a *copy* of a built-in does not inherit one — a copy is a user
 * personality and falls back to a tinted monogram like any other. Anodex wears
 * the app's own icon for the same reason its fields are locked: it is the
 * baseline you ask someone to switch to when diagnosing a problem.
 *
 * Pip has no art yet and renders as a monogram until it does.
 */
const BUILT_IN_ICONS: Record<string, string> = {
  [ANODEX_PERSONALITY_ID]: appIcon,
  'builtin:direct': valeIcon,
  'builtin:friendly': wrenIcon,
  'builtin:terse': cassIcon,
  'builtin:encouraging': junoIcon,
  'builtin:skeptical': rookIcon
}

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
  personality: Pick<ChatPersonality, 'id' | 'name' | 'image' | 'tint'>
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
  const builtInIcon = BUILT_IN_ICONS[personality.id]

  return (
    <span
      className={`${styles.avatar} ${className ?? ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.36)),
        borderRadius: Math.max(4, Math.round(size * 0.22)),
        // The shipped art carries its own ground; a tint behind it would only
        // show at the corners, where the two roundings disagree.
        background: builtInIcon ? 'transparent' : TINT_VAR[personality.tint ?? 'accent']
      }}
      aria-hidden="true"
      title={name}
    >
      {builtInIcon ? (
        <img src={builtInIcon} alt="" className={styles.image} />
      ) : dataUrl ? (
        <img src={dataUrl} alt="" className={styles.image} />
      ) : (
        personalityInitials(name)
      )}
    </span>
  )
}
