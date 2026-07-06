import { useSettingsStore } from '../../stores/settingsStore'
import styles from './SidebarProfile.module.css'

const PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  dev: 'Dev'
}

interface SidebarProfileProps {
  active: boolean
  onClick: () => void
}

function initials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

/** Pinned user profile footer for the sidebar. */
export function SidebarProfile({ active, onClick }: SidebarProfileProps): JSX.Element {
  const profile = useSettingsStore((s) => s.settings?.profile)

  return (
    <button
      type="button"
      className={`${styles.profile} ${active ? styles.profileActive : ''}`}
      onClick={onClick}
      title="Open settings"
    >
      <span className={styles.avatar}>
        {profile?.avatarBase64 ? (
          <img src={profile.avatarBase64} alt="" className={styles.avatarImage} />
        ) : (
          <span className={styles.avatarInitials}>{initials(profile?.displayName ?? 'U')}</span>
        )}
      </span>
      <span className={styles.text}>
        <span className={styles.topRow}>
          <span className={styles.name}>{profile?.displayName ?? 'Settings'}</span>
          <span className={styles.plan}>{PLAN_LABEL[profile?.planTier ?? 'free']} plan</span>
        </span>
        {profile?.email && <span className={styles.email}>{profile.email}</span>}
      </span>
    </button>
  )
}
