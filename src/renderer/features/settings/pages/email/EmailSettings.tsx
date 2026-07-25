import { useEffect, useState } from 'react'
import type {
  EmailAutoconfig,
  EmailConnectionStatus,
  EmailEndpoint,
  EmailSocketSecurity
} from '@shared/email.types'
import { useEmailStore } from '../../../../stores/emailStore'
import { useUiStore } from '../../../../stores/uiStore'
import { anodex } from '../../../../lib/anodex'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import { SelectControl, TextControl } from '../../controls'
import pageStyles from '../../SettingsPage.module.css'
import styles from './EmailSettings.module.css'

const SECURITY_OPTIONS = [
  { label: 'SSL/TLS', value: 'tls' },
  { label: 'STARTTLS', value: 'starttls' },
  { label: 'None', value: 'plain' }
]

const PROVIDER_LABELS: Record<string, string> = {
  gmail: 'Google',
  microsoft: 'Microsoft',
  imap: 'IMAP'
}

/** Which step of the add-account flow is on screen. */
type LinkStage = 'address' | 'oauth' | 'password'

export function EmailSettings(): JSX.Element {
  const notify = useUiStore((s) => s.notify)
  const [status, setStatus] = useState<EmailConnectionStatus | null>(null)
  const [stage, setStage] = useState<LinkStage>('address')
  const [address, setAddress] = useState('')
  const [config, setConfig] = useState<EmailAutoconfig | null>(null)
  const [password, setPassword] = useState('')
  const [imap, setImap] = useState<EmailEndpoint | null>(null)
  const [smtp, setSmtp] = useState<EmailEndpoint | null>(null)
  const [customClientId, setCustomClientId] = useState('')
  const [customClientSecret, setCustomClientSecret] = useState('')
  const [busy, setBusy] = useState(false)
  /** True when an OAuth-capable provider was linked over IMAP instead. */
  const [usingFallback, setUsingFallback] = useState(false)

  // The password step is shared by native IMAP providers and by the opt-out
  // fallback, which carry their app-password guidance in different places.
  const passwordSetup =
    usingFallback && config?.passwordFallback
      ? {
          serviceName: config.passwordFallback.serviceName,
          appPasswordUrl: config.passwordFallback.appPasswordUrl,
          requiresAppPassword: config.passwordFallback.requiresAppPassword,
          settingsAreGuesses: false
        }
      : {
          serviceName: config?.serviceName ?? '',
          appPasswordUrl: config?.appPasswordUrl,
          requiresAppPassword: config?.requiresAppPassword === true,
          settingsAreGuesses: config?.source === 'guess'
        }

  useEffect(() => {
    let cancelled = false
    void anodex.email.getStatus().then((result) => {
      if (!cancelled && result.ok) setStatus(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function refresh(next: EmailConnectionStatus): Promise<void> {
    setStatus(next)
    await useEmailStore.getState().load()
  }

  function resetFlow(): void {
    setStage('address')
    setAddress('')
    setConfig(null)
    setPassword('')
    setImap(null)
    setSmtp(null)
    setCustomClientId('')
    setCustomClientSecret('')
    setUsingFallback(false)
  }

  /** Switches an OAuth provider onto its IMAP + app-password route. */
  function usePasswordInstead(): void {
    const fallback = config?.passwordFallback
    if (!fallback) return
    setImap(fallback.imap)
    setSmtp(fallback.smtp)
    setUsingFallback(true)
    setStage('password')
  }

  const handleDiscover = async (): Promise<void> => {
    if (!address.trim()) return
    setBusy(true)
    try {
      const result = await anodex.email.discover(address.trim())
      if (!result.ok) {
        notify({
          kind: 'error',
          title: 'Could not look up that address',
          message: result.error.detail ?? result.error.message
        })
        return
      }
      const detected = result.value
      setConfig(detected)
      setImap(detected.imap ?? null)
      setSmtp(detected.smtp ?? null)
      setUsingFallback(false)
      setStage(detected.authKind === 'oauth' ? 'oauth' : 'password')
    } finally {
      setBusy(false)
    }
  }

  const handleConnectOAuth = async (): Promise<void> => {
    if (!config || config.provider === 'imap') return
    setBusy(true)
    try {
      const result = await anodex.email.connectOAuth({
        provider: config.provider,
        address: config.address,
        oauthClientId: customClientId.trim() || undefined,
        oauthClientSecret: customClientSecret.trim() || undefined
      })
      if (!result.ok) {
        notify({
          kind: 'error',
          title: 'Could not connect that account',
          message: result.error.detail ?? result.error.message
        })
        return
      }
      await refresh(result.value)
      notify({ kind: 'success', title: 'Account connected', message: result.value.address })
      resetFlow()
    } finally {
      setBusy(false)
    }
  }

  const handleConnectPassword = async (): Promise<void> => {
    if (!config || !imap || !smtp) return
    setBusy(true)
    try {
      const result = await anodex.email.connectPassword({
        address: config.address,
        // Providers display app passwords in space-separated groups for
        // legibility and accept them either way, so strip the spaces the user
        // almost certainly pasted along with the code. Only for app passwords —
        // a real mailbox password may legitimately contain spaces.
        password: passwordSetup.requiresAppPassword ? password.replace(/\s+/g, '') : password,
        imap,
        smtp
      })
      if (!result.ok) {
        notify({
          kind: 'error',
          title: 'Could not connect that account',
          message: result.error.detail ?? result.error.message
        })
        return
      }
      await refresh(result.value)
      notify({ kind: 'success', title: 'Account connected', message: config.address })
      resetFlow()
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (accountId: string, accountAddress: string): Promise<void> => {
    const result = await anodex.email.removeAccount(accountId)
    if (!result.ok) {
      notify({
        kind: 'error',
        title: 'Could not unlink that account',
        message: result.error.detail ?? result.error.message
      })
      return
    }
    await refresh(result.value)
    notify({ kind: 'success', title: 'Account unlinked', message: accountAddress })
  }

  const handleSetPrimary = async (accountId: string): Promise<void> => {
    const result = await anodex.email.setPrimaryAccount(accountId)
    if (result.ok) await refresh(result.value)
  }

  const accounts = status?.accounts ?? []

  return (
    <div className={pageStyles.page}>
      <header className={pageStyles.pageHeader}>
        <p className={pageStyles.pageKicker}>AI & Connections</p>
        <h1 className={pageStyles.pageTitle}>Email</h1>
        <p className={pageStyles.pageDesc}>
          Link Gmail, Outlook, or any IMAP mailbox so Anodex can search, summarize, draft, reply,
          and send with approval.
        </p>
      </header>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Linked accounts</h2>
        <p className={pageStyles.sectionDesc}>
          Tools use the default account unless they are told otherwise.
        </p>

        {accounts.length === 0 ? (
          <div className={styles.emptyState}>
            <Icon name="mail" size={28} />
            <span>No accounts linked yet. Add one below to turn on the email tools.</span>
          </div>
        ) : (
          <div className={styles.accountList}>
            {accounts.map((account) => (
              <div key={account.id} className={styles.accountRow}>
                <div className={styles.accountIcon}>
                  <Icon name="mail" size={18} />
                </div>
                <div className={styles.accountText}>
                  <span className={styles.accountAddress}>
                    {account.address}
                    {account.isPrimary && <span className={styles.badge}>Default</span>}
                    {!account.connected && (
                      <span className={`${styles.badge} ${styles.badgeWarning}`}>
                        Needs reconnect
                      </span>
                    )}
                  </span>
                  <span className={styles.accountMeta}>
                    {PROVIDER_LABELS[account.provider] ?? account.provider}
                    {account.reason ? ` — ${account.reason}` : ''}
                  </span>
                </div>
                <div className={styles.accountActions}>
                  {!account.isPrimary && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleSetPrimary(account.id)}
                    >
                      Make default
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleRemove(account.id, account.address)}
                  >
                    Unlink
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Add an account</h2>
        <p className={pageStyles.sectionDesc}>
          Type the address and Anodex works out the rest — a one-click sign-in for Gmail and
          Outlook, or prefilled server settings for everything else.
        </p>

        <div className={styles.linkCard}>
          <div className={styles.addressRow}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email address</span>
              <TextControl
                value={address}
                placeholder="you@example.com"
                onChange={(value) => {
                  setAddress(value)
                  // Editing the address invalidates whatever was detected for
                  // the previous one, so fall back to the first step.
                  if (stage !== 'address') {
                    setStage('address')
                    setConfig(null)
                  }
                }}
              />
            </label>
            <Button
              variant="primary"
              disabled={busy || !address.includes('@')}
              onClick={() => void handleDiscover()}
            >
              {busy && stage === 'address' ? 'Checking…' : 'Continue'}
            </Button>
          </div>

          {config && (
            <div className={styles.detected}>
              <div className={styles.accountIcon}>
                <Icon name="mail" size={18} />
              </div>
              <div className={styles.detectedText}>
                <strong>{config.serviceName}</strong>
                <span>{describeSource(config, usingFallback)}</span>
              </div>
            </div>
          )}

          {stage === 'oauth' && config && (
            <>
              <p className={styles.fieldHint}>
                A browser window opens for you to sign in to {config.serviceName}. Anodex never sees
                your password.
              </p>
              <details className={styles.advanced}>
                <summary className={styles.advancedSummary}>
                  <span>Use my own OAuth client</span>
                  <span>Optional</span>
                </summary>
                <div className={styles.advancedBody}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Client ID</span>
                    <TextControl
                      value={customClientId}
                      placeholder="Leave blank to use the built-in client"
                      onChange={setCustomClientId}
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Client secret</span>
                    <TextControl
                      type="password"
                      value={customClientSecret}
                      placeholder="Only if your client requires one"
                      onChange={setCustomClientSecret}
                    />
                    <span className={styles.fieldHint}>
                      Stored in the OS credential store, never in settings.
                    </span>
                  </label>
                </div>
              </details>
              <div className={styles.actions}>
                <Button variant="ghost" onClick={resetFlow} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  iconLeft={<Icon name="mail" size={14} />}
                  onClick={() => void handleConnectOAuth()}
                >
                  {busy
                    ? 'Waiting for sign-in…'
                    : `Sign in with ${PROVIDER_LABELS[config.provider]}`}
                </Button>
              </div>

              {config.passwordFallback && (
                <div className={styles.appPasswordNote}>
                  <span>
                    Sign-in not working? {config.passwordFallback.note} Anodex gets the same access
                    either way.
                  </span>
                  <button type="button" className={styles.inlineLink} onClick={usePasswordInstead}>
                    Use an app password instead
                  </button>
                </div>
              )}
            </>
          )}

          {stage === 'password' && config && imap && smtp && (
            <>
              {passwordSetup.requiresAppPassword && (
                <div className={styles.appPasswordNote}>
                  <span>
                    {passwordSetup.serviceName} requires an app-specific password — your normal
                    account password will not work. It also needs 2-Step Verification turned on
                    first, or the app-password page stays hidden. Generate one, then paste it below.
                  </span>
                  {passwordSetup.appPasswordUrl && (
                    <button
                      type="button"
                      className={styles.inlineLink}
                      // `setWindowOpenHandler` in the main process turns this
                      // into a `shell.openExternal` and denies the popup, so
                      // the link opens in the real browser, not inside Anodex.
                      onClick={() => window.open(passwordSetup.appPasswordUrl, '_blank')}
                    >
                      Open {passwordSetup.serviceName} app passwords
                    </button>
                  )}
                </div>
              )}

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Password</span>
                <TextControl
                  type="password"
                  value={password}
                  placeholder={
                    passwordSetup.requiresAppPassword ? 'App password' : 'Mailbox password'
                  }
                  onChange={setPassword}
                />
                {usingFallback && (
                  <span className={styles.fieldHint}>
                    Paste the 16-character code exactly as shown. Spaces are fine.
                  </span>
                )}
              </label>

              <details className={styles.advanced} open={passwordSetup.settingsAreGuesses}>
                <summary className={styles.advancedSummary}>
                  <span>Server settings</span>
                  <span>
                    {passwordSetup.settingsAreGuesses
                      ? 'Please check these'
                      : 'Detected automatically'}
                  </span>
                </summary>
                <div className={styles.advancedBody}>
                  <EndpointFields label="IMAP (incoming)" value={imap} onChange={setImap} />
                  <EndpointFields label="SMTP (outgoing)" value={smtp} onChange={setSmtp} />
                </div>
              </details>

              <div className={styles.actions}>
                <Button variant="ghost" onClick={resetFlow} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || !password}
                  onClick={() => void handleConnectPassword()}
                >
                  {busy ? 'Connecting…' : 'Connect'}
                </Button>
              </div>
            </>
          )}
        </div>
      </section>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Sending</h2>
        <p className={pageStyles.sectionDesc}>
          Outgoing mail is the one email action that can never be automated away.
        </p>
        <div className={styles.accountRow}>
          <div className={styles.accountText}>
            <span className={styles.accountAddress}>Confirm before sending</span>
            <span className={styles.accountMeta}>
              Sending and replying always ask for approval, regardless of permission mode.
            </span>
          </div>
          <span className={styles.fixedValue}>Always on</span>
        </div>
      </section>
    </div>
  )
}

interface EndpointFieldsProps {
  label: string
  value: EmailEndpoint
  onChange: (endpoint: EmailEndpoint) => void
}

function EndpointFields({ label, value, onChange }: EndpointFieldsProps): JSX.Element {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <div className={styles.serverGrid}>
        <TextControl
          value={value.host}
          placeholder="Host"
          onChange={(host) => onChange({ ...value, host })}
        />
        <TextControl
          value={String(value.port)}
          placeholder="Port"
          onChange={(port) => onChange({ ...value, port: Number(port) || value.port })}
        />
        <SelectControl
          value={value.security}
          options={SECURITY_OPTIONS}
          onChange={(security) => onChange({ ...value, security: security as EmailSocketSecurity })}
        />
        <TextControl
          value={value.username}
          placeholder="Username"
          onChange={(username) => onChange({ ...value, username })}
        />
      </div>
    </div>
  )
}

function describeSource(config: EmailAutoconfig, usingFallback: boolean): string {
  if (usingFallback) return 'Connecting over IMAP with an app password instead of sign-in.'
  if (config.authKind === 'oauth') return 'Sign in through your browser — no password stored.'
  if (config.source === 'builtin') return 'Server settings are built in.'
  if (config.source === 'ispdb') return 'Server settings found in the Mozilla autoconfig database.'
  return 'No published settings for this domain — the servers below are a guess, please check them.'
}
