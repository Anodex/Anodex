import { useCallback, useEffect, useState } from 'react'
import type { RemotePairingCode, RemoteStatus } from '@shared/remote.types'
import { anodex } from '../../../../lib/anodex'
import { useUiStore } from '../../../../stores/uiStore'
import { Button } from '../../../../components/ui/Button'
import { SettingRow } from '../../SettingRow'
import { ToggleControl } from '../../controls'
import pageStyles from '../../SettingsPage.module.css'
import styles from './RemoteSettings.module.css'

/**
 * Settings → Remote.
 *
 * The listener is off until turned on here, and the page is deliberately blunt
 * about what turning it on means: this is an open port into an application that
 * runs commands. Hiding that behind a friendly toggle would be the wrong kind of
 * polish.
 */
export function RemoteSettings(): JSX.Element {
  const notify = useUiStore((state) => state.notify)
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [pairing, setPairing] = useState<RemotePairingCode | null>(null)
  const [busy, setBusy] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [manualAddress, setManualAddress] = useState('')
  const [manualPort, setManualPort] = useState('')

  const refresh = useCallback(() => {
    void anodex.remote.status().then(setStatus)
  }, [])

  useEffect(() => {
    refresh()
    return anodex.remote.onStatusChanged(setStatus)
  }, [refresh])

  // A pairing code that has silently expired is worse than none: the user keeps
  // scanning something the desktop has already stopped honouring.
  useEffect(() => {
    if (!pairing) return
    const tick = (): void => {
      const remaining = Math.max(0, Math.round((pairing.expiresAtEpochMs - Date.now()) / 1000))
      setSecondsLeft(remaining)
      if (remaining === 0) setPairing(null)
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [pairing])

  const toggle = async (enabled: boolean): Promise<void> => {
    setBusy(true)
    const result = await anodex.remote.setEnabled(enabled)
    setBusy(false)
    if (!result.ok) {
      notify({
        kind: 'error',
        title: 'Could not change remote access',
        message: result.error.message
      })
      return
    }
    setStatus(result.value)
    if (!enabled) setPairing(null)
  }

  const showCode = async (): Promise<void> => {
    setBusy(true)
    const code = await anodex.remote.beginPairing()
    setBusy(false)
    if (!code) {
      notify({
        kind: 'error',
        title: 'Turn on remote access first',
        message: 'There is nothing for a phone to connect to yet.'
      })
      return
    }
    setPairing(code)
  }

  const cancel = async (): Promise<void> => {
    await anodex.remote.cancelPairing()
    setPairing(null)
  }

  const toggleInternet = async (enabled: boolean): Promise<void> => {
    setBusy(true)
    const result = await anodex.remote.setInternetAccess(enabled)
    setBusy(false)
    if (!result.ok) {
      notify({
        kind: 'error',
        title: 'Could not change internet access',
        message: result.error.message
      })
      return
    }
    setStatus(result.value)
  }

  const saveManualAddress = async (): Promise<void> => {
    setBusy(true)
    const port = manualPort.trim() ? Number(manualPort.trim()) : null
    const result = await anodex.remote.setManualAddress(
      manualAddress.trim() || null,
      Number.isFinite(port) ? port : null
    )
    setBusy(false)
    if (!result.ok) {
      notify({ kind: 'error', title: 'Could not save', message: result.error.message })
      return
    }
    setStatus(result.value)
    notify({
      kind: 'success',
      title: 'Address saved',
      message: 'Your phone will use it the next time it cannot find you on Wi-Fi.'
    })
  }

  const revoke = async (): Promise<void> => {
    setStatus(await anodex.remote.revoke())
    notify({
      kind: 'success',
      title: 'Phone unpaired',
      message: 'Its saved key stops working immediately.'
    })
  }

  const listening = status?.listening ?? false

  return (
    <div className={pageStyles.page}>
      <SettingRow
        label="Remote access"
        description={
          listening
            ? `Listening on port ${status?.port ?? '—'}. Your phone must be on the same network.`
            : 'Let one paired phone use Anodex while you are away from the computer.'
        }
        control={
          <ToggleControl
            checked={listening}
            ariaLabel="Remote access"
            onChange={(next) => {
              if (!busy) void toggle(next)
            }}
          />
        }
      />

      {listening && status && status.addresses.length > 0 && (
        <div className={styles.addresses}>
          <p className={styles.addressesLabel}>Your phone can reach this computer at:</p>
          <ul className={styles.addressList}>
            {status.addresses.map((entry) => (
              <li key={entry.address}>
                <code>
                  {entry.address}:{status.port}
                </code>
                <span className={styles.addressKind}>{describeAddress(entry.kind)}</span>
              </li>
            ))}
          </ul>
          {status.internet.enabled && status.internet.address && (
            <p className={styles.meshReady}>
              Your phone can reach this computer from anywhere, including mobile data.
            </p>
          )}
        </div>
      )}

      {listening && status && (
        <>
          <SettingRow
            label="Reach this computer from anywhere"
            description={
              status.internet.address
                ? `Open at ${status.internet.address}:${status.internet.port}${
                    status.internet.source === 'manual' ? ' — you set this up yourself.' : '.'
                  }`
                : 'Ask your router to let your phone in from outside your home network.'
            }
            control={
              <ToggleControl
                checked={status.internet.enabled}
                ariaLabel="Reach this computer from anywhere"
                onChange={(next) => {
                  if (!busy) void toggleInternet(next)
                }}
              />
            }
          />

          {status.internet.enabled && (
            <div className={styles.internet}>
              <p className={styles.internetWarning}>
                This is the big one. Turning it on means anyone on the internet can knock on this
                port — and they will, within hours, because the whole internet is scanned
                constantly. They cannot get in: without your phone&rsquo;s key the connection is
                refused before it can ask for anything. But this is now a door onto the world rather
                than a door onto your living room, so leave it off unless you actually need it.
              </p>

              {status.internet.problem && (
                <p className={styles.internetProblem}>{status.internet.problem}</p>
              )}

              {status.internet.source !== 'automatic' && (
                <details className={styles.forwarding} open={!status.internet.address}>
                  <summary>Set it up by hand</summary>
                  <p className={styles.forwardingHint}>
                    Most routers ship with automatic port opening switched off, so this usually has
                    to be done once, by you, in your router&rsquo;s settings. Nothing else is
                    involved — no account, no other company&rsquo;s servers, and your work never
                    leaves your two devices.
                  </p>
                  <ol className={styles.meshSteps}>
                    <li>
                      Open your router&rsquo;s settings page — usually <code>10.0.0.1</code> or{' '}
                      <code>192.168.1.1</code> in a browser.
                    </li>
                    <li>
                      Find <em>Port Forwarding</em> (sometimes under Advanced, NAT, or Virtual
                      Servers).
                    </li>
                    <li>
                      Forward external port <code>{status.port}</code> to{' '}
                      <code>
                        {status.addresses.find((a) => a.kind === 'lan')?.address ?? 'this computer'}
                      </code>{' '}
                      port <code>{status.port}</code>, protocol TCP.
                    </li>
                    <li>
                      Search the web for &ldquo;what is my IP&rdquo; and type the number it shows
                      below.
                    </li>
                  </ol>

                  <div className={styles.manualEntry}>
                    <label>
                      <span>Public address</span>
                      <input
                        type="text"
                        value={manualAddress}
                        placeholder="203.0.113.7"
                        onChange={(event) => setManualAddress(event.target.value)}
                      />
                    </label>
                    <label>
                      <span>Port</span>
                      <input
                        type="text"
                        value={manualPort}
                        placeholder={String(status.port ?? '')}
                        onChange={(event) => setManualPort(event.target.value)}
                      />
                    </label>
                    <Button onClick={() => void saveManualAddress()} disabled={busy}>
                      Save
                    </Button>
                  </div>

                  <p className={styles.forwardingHint}>
                    If your provider gives you a new address from time to time, come back and update
                    it here — or pair again on Wi-Fi, which refreshes it automatically.
                  </p>
                </details>
              )}
            </div>
          )}
        </>
      )}

      <p className={styles.warning}>
        This opens a port on this computer. Anything that connects can do what you can do in Anodex
        — read and write your files, and run commands. Only pair a phone you own, and turn this off
        when you are not using it.
      </p>

      {listening && (
        <>
          <SettingRow
            label="Paired phone"
            description={
              status?.pairedDevice
                ? `${status.pairedDevice.name} · last seen ${formatSeen(status.pairedDevice.lastSeenEpochMs)}`
                : 'No phone is paired yet.'
            }
            control={
              status?.pairedDevice ? (
                <Button variant="danger" onClick={() => void revoke()}>
                  Unpair
                </Button>
              ) : (
                <Button onClick={() => void showCode()} disabled={busy}>
                  Pair a phone
                </Button>
              )
            }
          />

          {pairing && (
            <div className={styles.pairing}>
              <img className={styles.qr} src={pairing.qrDataUrl} alt="Pairing code" />

              <div className={styles.details}>
                <p className={styles.instruction}>
                  Scan this with Anodex on your phone. It expires in {secondsLeft}s.
                </p>

                <p className={styles.fingerprintLabel}>Check this matches what your phone shows:</p>
                <code className={styles.fingerprint}>{groupFingerprint(pairing.fingerprint)}</code>

                <p className={styles.hint}>
                  If the two do not match, something else answered. Do not continue.
                </p>

                <details className={styles.manual}>
                  <summary>Can&rsquo;t scan it?</summary>
                  <p className={styles.manualHint}>
                    Enter these on the phone instead. The code is case-insensitive.
                  </p>
                  <dl className={styles.manualFields}>
                    <dt>Address</dt>
                    <dd>
                      <code>
                        {pairing.address}:{pairing.port}
                      </code>
                    </dd>
                    <dt>Code</dt>
                    <dd>
                      <code className={styles.shortCode}>{formatShortCode(pairing.shortCode)}</code>
                    </dd>
                  </dl>
                </details>

                <Button variant="ghost" onClick={() => void cancel()}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The first 10 bytes, grouped in fives — the same derivation the phone uses.
 *
 * Truncated because a 64-character string does not get read, it gets glanced at
 * and approved, and a fingerprint nobody checks is not a security control.
 */
function groupFingerprint(hex: string): string {
  const bytes = hex.slice(0, 20).toUpperCase().match(/.{2}/g) ?? []
  const first = bytes.slice(0, 5).join(' ')
  const second = bytes.slice(5, 10).join(' ')
  return `${first}  ${second}`
}

function describeAddress(kind: 'lan' | 'mesh' | 'internet' | 'virtual'): string {
  switch (kind) {
    case 'lan':
      return 'on this network — fastest, works at home'
    case 'mesh':
      return 'over your VPN — works anywhere'
    case 'internet':
      return 'from anywhere, including mobile data'
    case 'virtual':
      return 'virtual adapter — usually not reachable from a phone'
  }
}

/** Split into two groups of four: eight unbroken characters is hard to read back. */
function formatShortCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

function formatSeen(epochMs: number): string {
  const minutes = Math.round((Date.now() - epochMs) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes === 1) return 'a minute ago'
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  return hours === 1 ? 'an hour ago' : `${hours} hours ago`
}
