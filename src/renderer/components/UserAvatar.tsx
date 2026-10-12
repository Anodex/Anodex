import type { ProfileSettings } from '@shared/settings.types'
import { avatarGradient, initialsOf } from '@shared/userIdentity'
import { Icon } from './Icon'
import styles from './UserAvatar.module.css'

interface UserAvatarProps {
  profile: Pick<ProfileSettings, 'displayName' | 'avatarBase64' | 'avatarLook'>
  /** Diameter in pixels. */
  size: number
  className?: string
}

/**
 * The person, drawn the same way everywhere: their photo, or their initials on
 * the gradient they picked in the welcome. The phone draws the same thing.
 *
 * With neither a photo nor a name it is the plain person glyph, rather than an
 * empty coloured disc that looks like something failed to load.
 */
export function UserAvatar({ profile, size, className }: UserAvatarProps): JSX.Element {
  const initials = initialsOf(profile.displayName)
  const style = { width: size, height: size, fontSize: Math.round(size * 0.38) }
  if (profile.avatarBase64) {
    return (
      <span className={`${styles.avatar} ${className ?? ''}`} style={style}>
        <img src={profile.avatarBase64} alt="" className={styles.photo} />
      </span>
    )
  }
  return (
    <span
      className={`${styles.avatar} ${styles.drawn} ${className ?? ''}`}
      style={{ ...style, background: avatarGradient(profile.avatarLook) }}
    >
      {initials ? (
        <span className={styles.initials}>{initials}</span>
      ) : (
        <Icon name="user" size={Math.round(size * 0.5)} />
      )}
    </span>
  )
}
