import { useRef, useState, type ChangeEvent } from 'react'
import { PLACEHOLDER_NAME, firstName } from '@shared/userIdentity'
import { useSettingsStore } from '../../stores/settingsStore'
import { UserAvatar } from '../../components/UserAvatar'
import { AvatarLookPicker } from '../../components/AvatarLookPicker'
import { Icon } from '../../components/Icon'
import { cropAvatarToSquare } from '../settings/pages/profile/avatarImage'
import { WelcomeSteps } from './WelcomeFlow'
import styles from './Welcome.module.css'

/**
 * Step one: what to call you, and how to draw you.
 *
 * The heading answers as you type, which is the whole point of asking: it shows
 * the name is used, not filed. Nothing is saved until Continue.
 */
export function WelcomeYou({ onNext }: { onNext: () => void }): JSX.Element {
  const profile = useSettingsStore((s) => s.settings?.profile)
  const update = useSettingsStore((s) => s.update)
  const [name, setName] = useState(
    profile && profile.displayName !== PLACEHOLDER_NAME ? profile.displayName : ''
  )
  const [look, setLook] = useState(profile?.avatarLook ?? 0)
  const [photo, setPhoto] = useState<string | null>(profile?.avatarBase64 ?? null)
  const fileInput = useRef<HTMLInputElement>(null)

  const first = firstName(name)
  const drawn = { displayName: name, avatarBase64: photo, avatarLook: look }

  const pickPhoto = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => void cropAvatarToSquare(reader.result as string).then(setPhoto)
    reader.readAsDataURL(file)
  }

  const save = async (): Promise<void> => {
    await update({
      profile: {
        displayName: name.trim() || PLACEHOLDER_NAME,
        avatarLook: look,
        avatarBase64: photo
      }
    })
    onNext()
  }

  return (
    <div className={styles.card}>
      <WelcomeSteps at={1} />
      <div className={styles.avatarWrap}>
        <span className={styles.ring} aria-hidden="true" />
        <UserAvatar profile={drawn} size={120} className={styles.bigAvatar} />
        <button
          type="button"
          className={styles.cam}
          aria-label="Use a photo"
          onClick={() => fileInput.current?.click()}
        >
          <Icon name="camera" size={16} />
        </button>
      </div>
      <h1 className={styles.hello}>
        {first ? `Nice to meet you, ${first}.` : 'Welcome to Anodex'}
      </h1>
      <p className={styles.sub}>
        {first
          ? 'This is how Anodex will greet you, here and on your phone.'
          : 'It runs here, on this computer. What should it call you?'}
      </p>
      <label className={styles.field}>
        <span>Your name</span>
        <input
          autoFocus
          value={name}
          maxLength={40}
          placeholder="e.g. Sam"
          autoComplete="given-name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && first) void save()
          }}
        />
      </label>
      <AvatarLookPicker
        displayName={name}
        look={look}
        usingPhoto={photo !== null}
        onPickLook={(index) => {
          setLook(index)
          setPhoto(null)
        }}
        onPickPhoto={() => fileInput.current?.click()}
      />
      <input ref={fileInput} type="file" accept="image/*" hidden onChange={pickPhoto} />
      <p className={styles.private}>
        <Icon name="shield-check" size={13} />
        Stays on this computer, and on phones you pair.
      </p>
      <div className={styles.go}>
        <button type="button" className={styles.cta} disabled={!first} onClick={() => void save()}>
          Continue
        </button>
        <button type="button" className={styles.skip} onClick={onNext}>
          Skip for now
        </button>
      </div>
    </div>
  )
}
