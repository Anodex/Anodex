import { firstName } from '@shared/userIdentity'
import { readableModelName } from '../../lib/modelName'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { UserAvatar } from '../../components/UserAvatar'
import { Icon } from '../../components/Icon'
import { NoModelOnboarding } from '../chat/ChatEmptyState'
import { WelcomeSteps } from './WelcomeFlow'
import styles from './Welcome.module.css'

/**
 * Step two: a model that will answer.
 *
 * The same card the empty chat shows — one recommendation for this machine, with
 * the download and its tour — so there is one way to get a first model, not two.
 * A download keeps going if you move on; Continue does not wait for it.
 */
export function WelcomeModel({
  onBack,
  onNext,
  onOpenSettings
}: {
  onBack: () => void
  onNext: () => void
  onOpenSettings: () => void
}): JSX.Element {
  const profile = useSettingsStore((s) => s.settings?.profile)
  const engine = useModelStore((s) => s.engine)
  const downloading = useModelStore((s) =>
    Object.values(s.downloads).some((d) => d?.status === 'downloading')
  )
  const first = firstName(profile?.displayName)
  const ready = engine.status === 'ready' && engine.model

  return (
    <div className={`${styles.card} ${styles.left}`}>
      <WelcomeSteps at={2} />
      <div className={styles.greet}>
        {profile && <UserAvatar profile={profile} size={40} />}
        <div className={styles.greetText}>
          <b>{first ? `Hi ${first}` : 'Hi there'}</b>
          <span>Let&apos;s pick the model that will answer you.</span>
        </div>
      </div>
      {ready ? (
        <div className={styles.panel}>
          <div className={styles.readyRow}>
            <span className={styles.okDot}>
              <Icon name="check" size={16} />
            </span>
            <div>
              <b>{readableModelName(engine.model!.name)} is ready</b>
              <div className={styles.meta}>
                It runs on this computer. Nothing you type leaves it.
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.modelCard}>
          <NoModelOnboarding onOpenSettings={onOpenSettings} />
        </div>
      )}
      <div className={styles.row}>
        <button type="button" className={styles.back} onClick={onBack}>
          ‹ Back
        </button>
        {ready || downloading ? (
          <button type="button" className={`${styles.cta} ${styles.slim}`} onClick={onNext}>
            {ready ? 'Continue' : 'Continue while it downloads'}
          </button>
        ) : (
          <button type="button" className={styles.skip} onClick={onNext}>
            Skip for now
          </button>
        )}
      </div>
    </div>
  )
}
