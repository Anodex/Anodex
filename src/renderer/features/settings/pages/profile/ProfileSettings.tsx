import { useEffect, useRef, type ChangeEvent } from 'react'
import type { AppSettings, SettingsPatch } from '@shared/settings.types'
import { useEmailStore } from '../../../../stores/emailStore'
import { useUiStore } from '../../../../stores/uiStore'
import { Icon } from '../../../../components/Icon'
import { SettingRow } from '../../SettingRow'
import { SelectControl, TextControl, ToggleControl } from '../../controls'
import { UsageActivitySection } from './UsageActivitySection'
import { PersonalitySection } from './PersonalitySection'
import pageStyles from '../../SettingsPage.module.css'
import { avatarNeedsDownscale, downscaleAvatar } from './avatarImage'
import styles from './ProfileSettings.module.css'

interface ProfileSettingsProps {
  settings: AppSettings
  update: (patch: SettingsPatch) => Promise<void>
}

const PLAN_OPTIONS = [
  { label: 'Free', value: 'free' },
  { label: 'Pro', value: 'pro' },
  { label: 'Dev', value: 'dev' }
]

export function ProfileSettings({ settings, update }: ProfileSettingsProps): JSX.Element {
  const { profile } = settings
  const fileInputRef = useRef<HTMLInputElement>(null)
  const openSettings = useUiStore((state) => state.openSettings)
  const notify = useUiStore((state) => state.notify)
  // Email is not a profile field — it is whichever account is currently the
  // default, so this page reads it and sends edits to where it actually lives.
  const address = useEmailStore((state) => state.status?.address ?? '')
  const accountCount = useEmailStore((state) => state.status?.accounts.length ?? 0)

  // Shrink an avatar stored before it was bounded, once, in place. Existing
  // profiles otherwise keep paying the full-size cost on every settings write
  // until the user happens to choose a new picture — and re-encoding keeps the
  // picture they already chose rather than clearing it.
  useEffect(() => {
    const stored = profile.avatarBase64
    if (!avatarNeedsDownscale(stored)) return
    let cancelled = false
    void downscaleAvatar(stored as string).then((avatarBase64) => {
      if (!cancelled && avatarBase64 !== stored) void update({ profile: { avatarBase64 } })
    })
    return () => {
      cancelled = true
    }
  }, [profile.avatarBase64, update])

  const handleAvatarChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      // Downscaled before it is stored — see `downscaleAvatar`. Settings are
      // rewritten whole on every change, so a full-size photo here is paid for
      // by every later setting the user touches.
      void downscaleAvatar(reader.result as string).then((avatarBase64) =>
        update({ profile: { avatarBase64 } })
      )
    }
    reader.readAsDataURL(file)
  }

  return (
    <div className={pageStyles.page}>
      <header className={pageStyles.pageHeader}>
        <p className={pageStyles.pageKicker}>Personal</p>
        <h1 className={pageStyles.pageTitle}>Profile</h1>
        <p className={pageStyles.pageDesc}>
          Your identity, local account status, assistant preferences, and token activity.
        </p>
      </header>

      <section className={pageStyles.section}>
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
              onClick={() => void update({ profile: { avatarBase64: null } })}
            >
              Remove photo
            </button>
          )}
          <h2 className={styles.heroName}>{profile.displayName || 'Anonymous'}</h2>
          <p className={styles.heroMeta}>
            {address ? `${address} · ` : ''}
            {planLabel(profile.planTier)}
          </p>
        </div>
      </section>

      <UsageActivitySection />

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Edit profile</h2>
        <p className={pageStyles.sectionDesc}>How Anodex identifies you in the workspace.</p>

        <SettingRow
          label="Display name"
          description="Shown in the workspace header and on exports."
          control={
            <TextControl
              value={profile.displayName}
              placeholder="Your name"
              onChange={(value) => void update({ profile: { displayName: value } })}
            />
          }
        />
        <SettingRow
          label="Email"
          description={
            address
              ? accountCount > 1
                ? `Your default account, of ${accountCount} linked. Change it in Email settings.`
                : 'The account Anodex reads and sends from.'
              : 'Link a mailbox to turn on the email tools.'
          }
          control={
            <button
              type="button"
              className={styles.emailLink}
              onClick={() => openSettings('email')}
              title="Open Email settings"
            >
              <span className={styles.emailAddress}>{address || 'Connect an email account'}</span>
              <Icon name="chevron-right" size={14} />
            </button>
          }
        />
        <SettingRow
          label="Plan tier"
          description="Displayed for transparency. Does not change features."
          control={
            <SelectControl
              value={profile.planTier}
              options={PLAN_OPTIONS}
              onChange={(value) =>
                void update({ profile: { planTier: value as typeof profile.planTier } })
              }
            />
          }
        />
      </section>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Account</h2>
        <p className={pageStyles.sectionDesc}>Local-first status and data sync controls.</p>
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
              onChange={(value) =>
                void update({ profile: { syncStatus: value as typeof profile.syncStatus } })
              }
            />
          }
        />
        <SettingRow
          label="Account active"
          description="Toggle to simulate account state in the UI."
          control={
            <ToggleControl
              checked={profile.accountStatus === 'active'}
              onChange={(value) =>
                void update({ profile: { accountStatus: value ? 'active' : 'inactive' } })
              }
            />
          }
        />
      </section>

      {/* A rejected settings write rolls the optimistic update back, so a
          refused personality simply vanished with nothing said. That is how a
          validator rule that made creating one impossible went unnoticed. */}
      <PersonalitySection
        value={settings.assistantStyle}
        update={(patch) => {
          update({ assistantStyle: patch }).catch((error: unknown) => {
            notify({
              kind: 'error',
              title: 'Could not save that change',
              message: error instanceof Error ? error.message : undefined
            })
          })
        }}
      />
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
