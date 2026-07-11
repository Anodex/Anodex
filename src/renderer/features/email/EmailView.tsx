import { useEffect, useState } from 'react'
import type { EmailConnectionStatus, EmailThreadSummary } from '@shared/email.types'
import type { AppSettings } from '@shared/settings.types'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/ui/Button'
import { useSettingsStore } from '../../stores/settingsStore'
import { notifyError, useUiStore } from '../../stores/uiStore'
import { anodex } from '../../lib/anodex'
import { SelectControl, TextControl, ToggleControl } from '../settings/controls'
import styles from './EmailView.module.css'

const SYNC_OPTIONS: { label: string; value: AppSettings['email']['gmail']['syncMode'] }[] = [
  { label: 'Headers only', value: 'metadata' },
  { label: 'Full messages', value: 'full' }
]

export function EmailView(): JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.update)
  const notify = useUiStore((s) => s.notify)
  const [status, setStatus] = useState<EmailConnectionStatus | null>(null)
  const [threads, setThreads] = useState<EmailThreadSummary[]>([])

  const loadEmail = async (): Promise<void> => {
    if (!settings) return
    const statusResult = await anodex.email.getStatus()
    if (!statusResult.ok) return
    setStatus(statusResult.value)
    if (!statusResult.value.connected) {
      setThreads([])
      return
    }
    const threadsResult = await anodex.email.listThreads({ limit: 10 })
    if (threadsResult.ok) setThreads(threadsResult.value)
  }

  useEffect(() => {
    void loadEmail()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.email.provider, settings?.email.gmail.enabled])

  if (!settings) {
    return <div className={styles.view} />
  }

  const { email } = settings
  const gmail = email.gmail
  const gmailActive = email.provider === 'gmail' && gmail.enabled

  const updateEmail = (patch: Partial<AppSettings['email']>): void => {
    void updateSettings({ email: patch })
  }

  const updateGmail = (patch: Partial<AppSettings['email']['gmail']>): void => {
    void updateSettings({ email: { gmail: patch } })
  }

  const handleGmailToggle = (enabled: boolean): void => {
    updateEmail({
      provider: enabled ? 'gmail' : 'none',
      gmail: {
        ...gmail,
        enabled
      }
    })
  }

  const handleConnect = async (): Promise<void> => {
    const result = await anodex.email.connectGmail()
    if (!result.ok) {
      notifyError('Could not connect Gmail', result.error.detail ?? result.error.message)
      return
    }
    notify({
      kind: 'success',
      title: 'Gmail connected',
      message: result.value.address || 'Your Gmail account is ready.'
    })
    await useSettingsStore.getState().load()
    await loadEmail()
  }

  const handleOpenGmailWeb = async (): Promise<void> => {
    const result = await anodex.email.openGmailWeb()
    if (!result.ok) {
      notifyError('Could not open Gmail', result.error.detail ?? result.error.message)
    }
  }

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Email</h1>
          <p className={styles.subtitle}>Gmail is the first provider prepared for Anodex.</p>
        </div>
        <div className={styles.headerActions}>
          <Button
            variant="secondary"
            iconLeft={<Icon name="web" size={16} />}
            onClick={() => void handleOpenGmailWeb()}
          >
            Open Gmail
          </Button>
          <Button
            variant="primary"
            iconLeft={<Icon name="mail" size={16} />}
            disabled={!gmailActive}
            onClick={() => void handleConnect()}
          >
            Connect API
          </Button>
        </div>
      </div>

      <section className={styles.providerPanel}>
        <div className={styles.providerHeader}>
          <div className={styles.providerIcon}>
            <Icon name="mail" size={18} />
          </div>
          <div className={styles.providerTitleBlock}>
            <h2>Gmail</h2>
            <p>
              {status?.connected
                ? status.address || 'Connected'
                : status?.reason || (gmailActive ? 'Ready for account authorization.' : 'Not connected.')}
            </p>
          </div>
          <span className={`${styles.statusBadge} ${status?.connected ? styles.statusReady : ''}`}>
            {status?.connected ? 'Connected' : gmailActive ? 'Enabled' : 'Off'}
          </span>
        </div>

        <div className={styles.settingsGrid}>
          <label className={styles.settingRow}>
            <span>
              <strong>Use Gmail</strong>
              <small>Select Gmail as the email provider.</small>
            </span>
            <ToggleControl checked={gmailActive} onChange={handleGmailToggle} />
          </label>

          <label className={styles.settingRow}>
            <span>
              <strong>Gmail address</strong>
              <small>The account Anodex should authorize later.</small>
            </span>
            <TextControl
              value={gmail.address}
              placeholder="you@gmail.com"
              onChange={(address) => updateGmail({ address })}
            />
          </label>

          <label className={styles.settingRow}>
            <span>
              <strong>Sync scope</strong>
              <small>Start narrow, expand only when you need body search.</small>
            </span>
            <SelectControl
              value={gmail.syncMode}
              options={SYNC_OPTIONS}
              onChange={(syncMode) =>
                updateGmail({ syncMode: syncMode as AppSettings['email']['gmail']['syncMode'] })
              }
            />
          </label>

          <label className={styles.settingRow}>
            <span>
              <strong>Confirm before sending</strong>
              <small>Outbound email always requires explicit approval.</small>
            </span>
            <span className={styles.fixedValue}>Always on</span>
          </label>
        </div>
      </section>

      <section className={styles.mailboxPanel}>
        <div className={styles.mailboxHeader}>
          <h2>Inbox</h2>
          <span>Gmail</span>
        </div>
        {status?.connected ? (
          threads.length === 0 ? (
            <div className={styles.emptyInbox}>
              <Icon name="mail" size={32} />
              <p>No recent inbox threads found.</p>
            </div>
          ) : (
            <div className={styles.threadList}>
              {threads.map((thread) => (
                <div key={thread.id} className={styles.threadItem}>
                  <div className={styles.threadTitleRow}>
                    <strong>{thread.subject}</strong>
                    <span>{new Date(thread.updatedAt).toLocaleDateString()}</span>
                  </div>
                  <p>{thread.from}</p>
                  <small>{thread.snippet}</small>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className={styles.emptyInbox}>
            <Icon name="mail" size={32} />
            <p>Connect Gmail to read, summarize, draft, and send from this page.</p>
          </div>
        )}
      </section>

      <section className={styles.toolGrid}>
        <div className={styles.toolItem}>
          <Icon name="search" size={16} />
          <span>Search mail</span>
        </div>
        <div className={styles.toolItem}>
          <Icon name="chat" size={16} />
          <span>Summarize threads</span>
        </div>
        <div className={styles.toolItem}>
          <Icon name="pencil" size={16} />
          <span>Draft replies</span>
        </div>
        <div className={styles.toolItem}>
          <Icon name="send" size={16} />
          <span>Send with approval</span>
        </div>
      </section>
    </div>
  )
}
