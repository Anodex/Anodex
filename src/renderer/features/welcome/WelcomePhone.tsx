import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { RemotePairingCode } from '@shared/remote.types'
import { PHONE_APP_DOWNLOAD_URL, PHONE_APP_RELEASES_URL } from '@shared/phoneApp'
import { anodex } from '../../lib/anodex'
import { useSettingsStore } from '../../stores/settingsStore'
import { UserAvatar } from '../../components/UserAvatar'
import { Icon } from '../../components/Icon'
import { groupFingerprint } from '../settings/pages/remote/groupFingerprint'
import { WelcomeSteps } from './WelcomeFlow'
import styles from './Welcome.module.css'

type Tab = 'get' | 'pair'

/**
 * Step three: the phone. Get the app, then pair it.
 *
 * "Get the app" comes first because the app is not on the Play Store: without a
 * QR for the download, a new user has nowhere obvious to look. Pairing turns on
 * remote access only while it is waiting, and turns it back off if nothing
 * paired — a port opened by a welcome screen and left open would be a surprise.
 */
export function WelcomePhone({
  paired,
  onPaired,
  onBack,
  onNext
}: {
  paired: boolean
  onPaired: (name: string) => void
  onBack: () => void
  onNext: () => void
}): JSX.Element {
  const profile = useSettingsStore((s) => s.settings?.profile)
  const [tab, setTab] = useState<Tab>('get')
  const [downloadQr, setDownloadQr] = useState<string | null>(null)
  const [pairing, setPairing] = useState<RemotePairingCode | null>(null)
  const [pairedName, setPairedName] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const pairedRef = useRef(paired)
  pairedRef.current = paired

  useEffect(() => {
    void QRCode.toDataURL(PHONE_APP_DOWNLOAD_URL, { margin: 1, width: 264 }).then(setDownloadQr)
  }, [])

  // Pairing: open a window while this tab shows, renew it when it expires, and
  // put everything back the way it was when the step is left without a phone.
  useEffect(() => {
    if (tab !== 'pair' || paired) return
    let cancelled = false
    let turnedOn = false
    let known = new Set<string>()
    let renew: ReturnType<typeof setTimeout> | undefined

    const open = async (): Promise<void> => {
      const code = await anodex.remote.beginPairing()
      if (cancelled) return
      if (!code) {
        setProblem('Could not show a code. Try Settings → Remote.')
        return
      }
      setPairing(code)
      renew = setTimeout(() => void open(), Math.max(5_000, code.expiresAtEpochMs - Date.now()))
    }

    void (async () => {
      const status = await anodex.remote.status()
      known = new Set(status.pairedDevices.map((device) => device.deviceId))
      if (!status.listening) {
        const result = await anodex.remote.setEnabled(true)
        if (!result.ok) {
          if (!cancelled)
            setProblem('Remote access could not start, so there is nothing to pair with.')
          return
        }
        turnedOn = true
      }
      if (!cancelled) await open()
    })()

    const off = anodex.remote.onStatusChanged((status) => {
      const added = status.pairedDevices.find((device) => !known.has(device.deviceId))
      if (added) {
        setPairedName(added.name)
        onPaired(added.name)
      }
    })

    return () => {
      cancelled = true
      off()
      if (renew) clearTimeout(renew)
      void anodex.remote.cancelPairing()
      if (turnedOn && !pairedRef.current) void anodex.remote.setEnabled(false)
    }
    // onPaired is a fresh closure each render; the subscription only needs the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, paired])

  return (
    <div className={`${styles.card} ${styles.left}`}>
      <WelcomeSteps at={3} />
      <div className={styles.greet}>
        {profile && <UserAvatar profile={profile} size={40} />}
        <div className={styles.greetText}>
          <b>Bring Anodex to your phone</b>
          <span>Ask from anywhere at home, and get told when things finish.</span>
        </div>
      </div>

      {paired ? (
        <div className={styles.panel}>
          <div className={styles.readyRow}>
            <span className={styles.okDot}>
              <Icon name="check" size={16} />
            </span>
            <div>
              <b>Paired with {pairedName ?? 'your phone'}</b>
              <div className={styles.meta}>
                Your phone greeted you by name. Pair more in Settings → Remote.
              </div>
            </div>
          </div>
          <button type="button" className={styles.cta} onClick={onNext}>
            Finish
          </button>
        </div>
      ) : (
        <>
          <div className={styles.tabs} role="group" aria-label="Phone setup">
            <button type="button" aria-pressed={tab === 'get'} onClick={() => setTab('get')}>
              1 · Get the app
            </button>
            <button type="button" aria-pressed={tab === 'pair'} onClick={() => setTab('pair')}>
              2 · Pair
            </button>
          </div>
          {tab === 'get' ? (
            <div className={`${styles.panel} ${styles.qrPanel}`}>
              {downloadQr && (
                <img
                  className={styles.qr}
                  src={downloadQr}
                  alt="QR code for the Android download"
                />
              )}
              <div className={styles.qrText}>
                <b>Scan with your phone&apos;s camera</b> to download Anodex for Android.
                <a
                  className={styles.link}
                  href={PHONE_APP_RELEASES_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Or open the download page ↗
                </a>
                <p className={styles.hint}>
                  It isn&apos;t on the Play Store yet, so Android asks to allow the install:
                  that&apos;s expected. Every release is signed by Anodex. iPhone isn&apos;t
                  supported yet.
                </p>
                <button
                  type="button"
                  className={`${styles.cta} ${styles.slim}`}
                  onClick={() => setTab('pair')}
                >
                  I have the app
                </button>
              </div>
            </div>
          ) : (
            <div className={`${styles.panel} ${styles.qrPanel}`}>
              {pairing ? (
                <img className={styles.qr} src={pairing.qrDataUrl} alt="Pairing code" />
              ) : (
                <div className={`${styles.qr} ${styles.qrWaiting}`} />
              )}
              <div className={styles.qrText}>
                <b>1.</b> Open Anodex on your phone.
                <br />
                <b>2.</b> Tap <i>Scan the code</i> and point it here.
                <br />
                <b>3.</b> Check the phone shows this code:
                <code className={styles.fp}>
                  {pairing ? groupFingerprint(pairing.fingerprint) : '…'}
                </code>
                {pairing && (
                  // For a phone whose camera cannot read the code: the phone's
                  // "Enter the code instead" asks for exactly these three.
                  <details className={styles.manual}>
                    <summary>Can&apos;t scan it?</summary>
                    Tap <i>Enter the code instead</i> on the phone and type:
                    <dl>
                      <dt>Address</dt>
                      <dd>{pairing.address}</dd>
                      <dt>Port</dt>
                      <dd>{pairing.port}</dd>
                      <dt>Code</dt>
                      <dd>{pairing.shortCode}</dd>
                    </dl>
                  </details>
                )}
                {problem ? (
                  <p className={styles.hint}>{problem}</p>
                ) : (
                  <p className={styles.wait}>
                    <span className={styles.spin} aria-hidden="true" />
                    Waiting for your phone…
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      )}

      <div className={styles.row}>
        <button type="button" className={styles.back} onClick={onBack}>
          ‹ Back
        </button>
        {!paired && (
          <button type="button" className={styles.skip} onClick={onNext}>
            Skip, I&apos;ll do this later
          </button>
        )}
      </div>
    </div>
  )
}
