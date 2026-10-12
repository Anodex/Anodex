import { useRef, useState, type ChangeEvent } from 'react'
import { PLACEHOLDER_NAME, firstName } from '@shared/userIdentity'
import { useSettingsStore } from '../../stores/settingsStore'
import { UserAvatar } from '../../components/UserAvatar'
import { AvatarLookPicker } from '../../components/AvatarLookPicker'
import { cropAvatarToSquare } from '../settings/pages/profile/avatarImage'
import styles from './NamePrompt.module.css'

/**
 * "What should Anodex call you?", asked once in the chat of someone who has no
 * name: an install updated from before the welcome, or a welcome where the name
 * was skipped. The same name box and colours as the welcome, without the rest of
 * it. Save or Not now both mean it is never asked again; Profile still changes it.
 */
export function NamePrompt(): JSX.Element | null {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const [name, setName] = useState('')
  const [look, setLook] = useState(settings?.profile.avatarLook ?? 0)
  const [photo, setPhoto] = useState<string | null>(settings?.profile.avatarBase64 ?? null)
  const fileInput = useRef<HTMLInputElement>(null)

  if (
    !settings ||
    !settings.welcome.completed ||
    settings.welcome.nameAsked ||
    firstName(settings.profile.displayName)
  ) {
    return null
  }

  const first = firstName(name)

  const pickPhoto = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => void cropAvatarToSquare(reader.result as string).then(setPhoto)
    reader.readAsDataURL(file)
  }

  const save = (): void => {
    void update({
      profile: {
        displayName: name.trim() || PLACEHOLDER_NAME,
        avatarLook: look,
        avatarBase64: photo
      },
      welcome: { nameAsked: true }
    })
  }

  return (
    <section className={styles.card} aria-labelledby="name-prompt-title">
      <div className={styles.head}>
        <UserAvatar
          profile={{ displayName: name, avatarBase64: photo, avatarLook: look }}
          size={44}
        />
        <div className={styles.headText}>
          <h3 id="name-prompt-title">What should Anodex call you?</h3>
          <p>Used in greetings, on your profile and on your phone. It stays on this computer.</p>
        </div>
      </div>
      <input
        className={styles.input}
        aria-label="Your name"
        value={name}
        maxLength={40}
        placeholder="Your name"
        autoComplete="given-name"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && first) save()
        }}
      />
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
      <div className={styles.actions}>
        <button type="button" className={styles.save} disabled={!first} onClick={save}>
          Save
        </button>
        <button
          type="button"
          className={styles.later}
          onClick={() => void update({ welcome: { nameAsked: true } })}
        >
          Not now
        </button>
      </div>
    </section>
  )
}
