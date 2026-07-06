import { useRef, type ChangeEvent } from 'react'
import type { AppSettings } from '@shared/settings.types'
import { SettingRow } from '../../SettingRow'
import { SelectControl, TextControl, ToggleControl } from '../../controls'
import { UsageActivitySection } from './UsageActivitySection'
import styles from './ProfileSettings.module.css'

interface ProfileSettingsProps {
  settings: AppSettings
  update: (patch: Partial<AppSettings['profile']>) => void
}

const PLAN_OPTIONS = [
  { label: 'Free', value: 'free' },
  { label: 'Pro', value: 'pro' },
  { label: 'Dev', value: 'dev' }
]

export function ProfileSettings({ settings, update }: ProfileSettingsProps): JSX.Element {
  const { profile } = settings
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleAvatarChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      update({ avatarBase64: result })
    }
    reader.readAsDataURL(file)
  }

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <button
          type="button"
          className={styles.heroAvatar}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Change avatar"
        >
          {profile.avatarBase64 ? (
            <img src={profile.avatarBase64} alt="" className={styles.avatarImage} />
          ) : (
            <span className={styles.avatarInitials}>{initials(profile.displayName)}</span>
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className={styles.fileInput}
          onChange={handleAvatarChange}
        />
        {profile.avatarBase64 && (
          <button
            type="button"
            className={styles.removeAvatar}
            onClick={() => update({ avatarBase64: null })}
          >
            Remove photo
          </button>
        )}
        <h2 className={styles.heroName}>{profile.displayName || 'Anonymous'}</h2>
        <p className={styles.heroMeta}>
          {profile.email || 'No email set'} · {planLabel(profile.planTier)}
        </p>
      </div>

      <UsageActivitySection />

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Edit profile</h2>
        <p className={styles.sectionDesc}>How Anodex identifies you in the workspace.</p>

        <SettingRow
          label="Display name"
          description="Shown in the workspace header and on exports."
          control={
            <TextControl
              value={profile.displayName}
              placeholder="Your name"
              onChange={(value) => update({ displayName: value })}
            />
          }
        />
        <SettingRow
          label="Email"
          description="Used only for local identification; never uploaded."
          control={
            <TextControl
              value={profile.email}
              placeholder="you@example.com"
              onChange={(value) => update({ email: value })}
            />
          }
        />
        <SettingRow
          label="Plan tier"
          description="Displayed for transparency. Does not change features."
          control={
            <SelectControl
              value={profile.planTier}
              options={PLAN_OPTIONS}
              onChange={(value) => update({ planTier: value as typeof profile.planTier })}
            />
          }
        />
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Account</h2>
        <p className={styles.sectionDesc}>Local-first status and data sync controls.</p>
        <SettingRow
          label="Data sync"
          description={syncDescription(profile.syncStatus)}
          control={
            <SelectControl
              value={profile.syncStatus}
              options={[
                { label: 'Local only', value: 'local' },
                { label: 'Syncing', value: 'syncing' },
                { label: 'Synced', value: 'synced' }
              ]}
              onChange={(value) => update({ syncStatus: value as typeof profile.syncStatus })}
            />
          }
        />
        <SettingRow
          label="Account active"
          description="Toggle to simulate account state in the UI."
          control={
            <ToggleControl
              checked={profile.accountStatus === 'active'}
              onChange={(value) => update({ accountStatus: value ? 'active' : 'inactive' })}
            />
          }
        />
      </section>
    </div>
  )
}

function initials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

function planLabel(tier: AppSettings['profile']['planTier']): string {
  return PLAN_OPTIONS.find((option) => option.value === tier)?.label ?? tier
}

function syncDescription(status: AppSettings['profile']['syncStatus']): string {
  switch (status) {
    case 'local':
      return 'All data stays on this machine.'
    case 'syncing':
      return 'Sync is in progress.'
    case 'synced':
      return 'Data is synchronised.'
  }
}
