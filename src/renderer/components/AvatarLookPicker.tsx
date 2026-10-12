import { AVATAR_LOOKS, avatarGradient, initialsOf } from '@shared/userIdentity'
import { Icon } from './Icon'
import styles from './AvatarLookPicker.module.css'

interface AvatarLookPickerProps {
  displayName: string
  look: number
  /** True while a photo is the avatar, so no colour reads as chosen. */
  usingPhoto: boolean
  onPickLook: (look: number) => void
  onPickPhoto: () => void
}

/** The six gradients and a photo, as a row of round choices. The welcome's and Profile's. */
export function AvatarLookPicker({
  displayName,
  look,
  usingPhoto,
  onPickLook,
  onPickPhoto
}: AvatarLookPickerProps): JSX.Element {
  const initials = initialsOf(displayName) || 'A'
  return (
    <div className={styles.looks} role="group" aria-label="Pick a look">
      {AVATAR_LOOKS.map((_, index) => (
        <button
          key={index}
          type="button"
          className={styles.look}
          style={{ background: avatarGradient(index) }}
          aria-label={`Colour ${index + 1}`}
          aria-pressed={!usingPhoto && index === look}
          onClick={() => onPickLook(index)}
        >
          {initials}
        </button>
      ))}
      <button
        type="button"
        className={`${styles.look} ${styles.photo}`}
        aria-label="Use a photo"
        aria-pressed={usingPhoto}
        onClick={onPickPhoto}
      >
        <Icon name="camera" size={15} />
      </button>
    </div>
  )
}
