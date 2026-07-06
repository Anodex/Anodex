import { useEffect, useState } from 'react'
import { anodex } from './lib/anodex'
import titleLogo from './assets/title-logo.png'
import styles from './ToastWindow.module.css'

/**
 * Time visible before auto-dismissing. This (not `main/toastWindow.ts`'s
 * timer, a backstop for when this JS never runs at all) is what normally
 * closes the window, so the fade-out below always gets to play.
 */
const LIFETIME_MS = 4800
/** Matches the CSS fade-out transition duration below. */
const LEAVE_MS = 180

interface ToastParams {
  title: string
  body: string
}

function readParams(): ToastParams {
  const params = new URLSearchParams(window.location.search)
  return {
    title: params.get('title') ?? 'Notification',
    body: params.get('body') ?? ''
  }
}

/**
 * Renders inside a separate, always-on-top `BrowserWindow` (see
 * `main/toastWindow.ts`) instead of the main app shell — mounted directly by
 * `main.tsx` when the URL carries `?mode=toast`, bypassing `useAnodexBridge()`
 * and the rest of the app entirely since this window only ever needs to show
 * one message and then close.
 */
export function ToastWindow(): JSX.Element {
  const [{ title, body }] = useState(readParams)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const dismissTimer = setTimeout(() => setLeaving(true), LIFETIME_MS)
    return () => clearTimeout(dismissTimer)
  }, [])

  useEffect(() => {
    if (!leaving) return
    const closeTimer = setTimeout(() => window.close(), LEAVE_MS)
    return () => clearTimeout(closeTimer)
  }, [leaving])

  const focusAndDismiss = (): void => {
    void anodex.toast.focusMain()
    setLeaving(true)
  }

  return (
    <div className={styles.stage}>
      {/* No keyboard handling: the window is created with `focusable: false`
          (see `main/toastWindow.ts`), so it can never receive key events. */}
      <div className={`${styles.toast} ${leaving ? styles.leaving : ''}`} onClick={focusAndDismiss}>
        <span className={styles.brand}>
          <img src={titleLogo} alt="" />
        </span>
        <div className={styles.content}>
          <p className={styles.title}>{title}</p>
          {body && <p className={styles.body}>{body}</p>}
        </div>
      </div>
    </div>
  )
}
