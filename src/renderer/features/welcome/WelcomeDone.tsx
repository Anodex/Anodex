import { firstName } from '@shared/userIdentity'
import { readableModelName } from '../../lib/modelName'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { UserAvatar } from '../../components/UserAvatar'
import styles from './Welcome.module.css'

/**
 * The end: what was set up, and where to find whatever was skipped.
 *
 * Said line by line rather than "You're all set" alone, because a skipped step is
 * otherwise something the person has to remember on their own.
 */
export function WelcomeDone({
  paired,
  onFinish
}: {
  paired: boolean
  onFinish: () => void
}): JSX.Element {
  const profile = useSettingsStore((s) => s.settings?.profile)
  const engine = useModelStore((s) => s.engine)
  const downloading = useModelStore((s) =>
    Object.values(s.downloads).some((d) => d?.status === 'downloading')
  )
  const first = firstName(profile?.displayName)
  const model =
    engine.status === 'ready' && engine.model ? readableModelName(engine.model.name) : null

  const lines: Array<{ done: boolean; text: string }> = [
    first
      ? { done: true, text: `Anodex will call you ${first}` }
      : { done: false, text: 'No name yet: set one in Settings → Profile' },
    model
      ? { done: true, text: `${model} is ready to answer` }
      : downloading
        ? { done: false, text: 'Your model is still downloading; chat opens when it is ready' }
        : { done: false, text: 'No model yet: pick one in Settings → AI & Models' },
    paired
      ? { done: true, text: 'Your phone is paired' }
      : { done: false, text: 'Pair a phone any time in Settings → Remote' }
  ]

  return (
    <div className={styles.card}>
      <div className={styles.avatarWrap}>
        <span className={styles.ring} aria-hidden="true" />
        {profile && <UserAvatar profile={profile} size={120} className={styles.bigAvatar} />}
      </div>
      <h1 className={styles.hello}>{first ? `You're all set, ${first}.` : "You're all set."}</h1>
      <ul className={styles.checks}>
        {lines.map((line) => (
          <li key={line.text} className={line.done ? styles.yes : styles.no}>
            {line.done ? '✓' : '○'} {line.text}
          </li>
        ))}
      </ul>
      <button type="button" className={styles.cta} onClick={onFinish}>
        Start chatting
      </button>
    </div>
  )
}
