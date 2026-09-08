import { useEffect, useState } from 'react'
import { anodex } from '../../lib/anodex'
import { Icon } from '../../components/Icon'
import type { UpdateStatus } from '@shared/update.types'
import styles from './UpdateNotice.module.css'

/**
 * Says a new version exists, where somebody will actually see it.
 *
 * The update machinery has been complete for a while — it checks on launch, it
 * knows what version is out, it can download and install. It reported all of that
 * in Settings → About and nowhere else, which is a page nobody opens to find out
 * something they did not know to look for. So a new build could sit on GitHub
 * indefinitely while the app quietly knew about it.
 *
 * Not a toast: those clear themselves after a few seconds and carry no action, and
 * this is precisely the notice you want to still be there when you look up. Not a
 * modal either — nothing here is urgent enough to take the window away from
 * somebody mid-sentence.
 *
 * It appears for exactly two states. `available` is the offer; `downloaded` is the
 * one that matters more, because at that point the work is done and all that
 * remains is a restart nobody has asked for yet. Checking, idle, and
 * not-available are the app talking to itself and stay out of the way.
 *
 * Dismissing is remembered per version, so declining 0.2.0 does not mean being
 * asked again in ten minutes — and does not mean silence when 0.3.0 arrives.
 */
export function UpdateNotice(): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)

  useEffect(() => {
    void anodex.updates.getStatus().then(setStatus)
    return anodex.updates.onStatusChanged(setStatus)
  }, [])

  const version =
    status.state === 'available' || status.state === 'downloaded' ? status.version : null

  // Downloading is shown only once the offer has been accepted — the bar stays put
  // and reports progress rather than vanishing, so the thing you just clicked does
  // not appear to have done nothing.
  const downloading = status.state === 'downloading' ? status.percent : null

  if (downloading === null && version === null) return null
  if (version !== null && dismissedVersion === version) return null

  const ready = status.state === 'downloaded'

  return (
    <div className={styles.notice} role="status" aria-live="polite">
      <span className={styles.icon}>
        <Icon name={ready ? 'check' : 'download'} size={16} />
      </span>

      <div className={styles.body}>
        <div className={styles.title}>
          {ready ? `Anodex ${version} is ready to install` : `Anodex ${version} is available`}
        </div>
        <div className={styles.message}>
          {downloading !== null
            ? `Downloading… ${downloading}%`
            : ready
              ? 'Restarting takes a few seconds. Nothing in progress is lost.'
              : 'Downloads in the background — you can keep working.'}
        </div>
      </div>

      {downloading === null && (
        <button
          className={styles.action}
          onClick={() =>
            void (ready ? anodex.updates.installAndRestart() : anodex.updates.download())
          }
        >
          {ready ? 'Restart now' : 'Update'}
        </button>
      )}

      {/* No way out while it downloads: the bar is the only progress there is, and
          closing it would leave a download running with nothing reporting it. */}
      {downloading === null && (
        <button
          className={styles.close}
          onClick={() => setDismissedVersion(version)}
          aria-label="Dismiss"
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  )
}
