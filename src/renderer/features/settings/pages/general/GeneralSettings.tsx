import type { AppSettings } from '@shared/settings.types'
import { SettingRow } from '../../SettingRow'
import { ToggleControl } from '../../controls'
import pageStyles from '../../SettingsPage.module.css'

interface GeneralSettingsProps {
  settings: AppSettings
  update: (patch: Partial<AppSettings['general']>) => void
}

export function GeneralSettings({ settings, update }: GeneralSettingsProps): JSX.Element {
  return (
    <div className={pageStyles.page}>
      <header className={pageStyles.pageHeader}>
        <p className={pageStyles.pageKicker}>Workspace</p>
        <h1 className={pageStyles.pageTitle}>General</h1>
        <p className={pageStyles.pageDesc}>Everyday application behavior and notifications.</p>
      </header>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Notifications</h2>
        <p className={pageStyles.sectionDesc}>Choose when Anodex should alert you.</p>
        <SettingRow
          label="Desktop notifications"
          description="Notify when long generations or model loads finish."
          control={
            <ToggleControl
              checked={settings.general.desktopNotifications}
              onChange={(value) => update({ desktopNotifications: value })}
            />
          }
        />
      </section>
    </div>
  )
}
