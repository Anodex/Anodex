import { useEffect, useState } from 'react'
import type { EmailConnectionStatus } from '@shared/email.types'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { useUiStore } from '../../../../stores/uiStore'
import { anodex } from '../../../../lib/anodex'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import { SettingRow } from '../../SettingRow'
import { SelectControl, TextControl, ToggleControl } from '../../controls'
import pageStyles from '../../SettingsPage.module.css'
import styles from './EmailSettings.module.css'

const SYNC_OPTIONS = [
  { label: 'Headers only', value: 'metadata' },
  { label: 'Full messages', value: 'full' }
]

export function EmailSettings(): JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const notify = useUiStore((s) => s.notify)
  const [status, setStatus] = useState<EmailConnectionStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    void anodex.email.getStatus().then((result) => {
      if (!cancelled && result.ok) setStatus(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!settings) return <></>

  const gmail = settings.email.gmail
  const gmailEnabled = settings.email.provider === 'gmail' && gmail.enabled

  async function loadStatus(): Promise<void> {
    const result = await anodex.email.getStatus()
    if (result.ok) setStatus(result.value)
  }

  const setEnabled = (enabled: boolean): void => {
    void update({
      email: {
        provider: enabled ? 'gmail' : 'none',
        gmail: { enabled }
      }
    }).then(loadStatus)
  }

  const handleConnect = (): void => {
    void anodex.email.connectGmail().then((result) => {
      if (result.ok) {
        setStatus(result.value)
        notify({
          kind: 'success',
          title: 'Gmail connected',
          message: result.value.address || 'Your Gmail account is ready.'
        })
        void useSettingsStore.getState().load()
        return
      }
      notify({
        kind: 'error',
        title: 'Could not connect Gmail',
        message: result.error.detail ?? result.error.message
      })
    })
  }

  const handleDisconnect = (): void => {
    void anodex.email.disconnectGmail().then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }

  return (
    <div className={pageStyles.page}>
      <header className={pageStyles.pageHeader}>
        <p className={pageStyles.pageKicker}>Connections</p>
        <h1 className={pageStyles.pageTitle}>Email</h1>
        <p className={pageStyles.pageDesc}>
          Connect Gmail so Anodex can search, summarize, draft, and send email with approval.
        </p>
      </header>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Gmail connection</h2>
        <p className={pageStyles.sectionDesc}>Connection status, sync scope, and account setup.</p>

        <div className={styles.statusCard}>
          <div className={styles.statusIcon}>
            <Icon name="mail" size={18} />
          </div>
          <div className={styles.statusText}>
            <strong>{status?.connected ? 'Gmail connected' : 'Gmail not connected'}</strong>
            <span>{status?.reason ?? 'Enable Gmail to prepare account authorization.'}</span>
          </div>
          <div className={styles.statusActions}>
            {status?.connected && (
              <Button variant="secondary" size="sm" onClick={handleDisconnect}>
                Disconnect
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              disabled={!gmailEnabled}
              iconLeft={<Icon name="mail" size={14} />}
              onClick={handleConnect}
            >
              Connect
            </Button>
          </div>
        </div>

        <SettingRow
          label="Use Gmail"
          description="Gmail is the first email provider for Anodex."
          control={<ToggleControl checked={gmailEnabled} onChange={setEnabled} />}
        />
        <SettingRow
          label="Gmail address"
          description="Filled from Gmail after authorization; you can enter it before connecting."
          control={
            <TextControl
              value={gmail.address}
              placeholder="you@gmail.com"
              onChange={(address) => void update({ email: { gmail: { address } } })}
            />
          }
        />
        <details className={styles.advanced}>
          <summary className={styles.advancedSummary}>
            <span>Advanced OAuth setup</span>
            <span>Google Desktop app credentials</span>
          </summary>
          <SettingRow
            label="OAuth Client ID"
            description="Create a Google OAuth Desktop app client and paste its Client ID here."
            control={
              <TextControl
                value={gmail.oauthClientId}
                placeholder="Google OAuth Client ID"
                onChange={(oauthClientId) => void update({ email: { gmail: { oauthClientId } } })}
              />
            }
          />
          <SettingRow
            label="OAuth Client Secret"
            description="Desktop app client secret from Google Cloud. Stored locally."
            control={
              <TextControl
                type="password"
                value={gmail.oauthClientSecret}
                placeholder="Google OAuth Client Secret"
                onChange={(oauthClientSecret) =>
                  void update({ email: { gmail: { oauthClientSecret } } })
                }
              />
            }
          />
        </details>
        <SettingRow
          label="Sync scope"
          description="Metadata keeps the local cache smaller; full messages enable body search and summaries."
          control={
            <SelectControl
              value={gmail.syncMode}
              options={SYNC_OPTIONS}
              onChange={(syncMode) =>
                void update({
                  email: {
                    gmail: { syncMode: syncMode as typeof gmail.syncMode }
                  }
                })
              }
            />
          }
        />
        <SettingRow
          label="Confirm before sending"
          description="Sending email always asks for approval, regardless of permission mode."
          control={<span className={styles.fixedValue}>Always on</span>}
        />
      </section>
    </div>
  )
}
