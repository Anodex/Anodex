import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import styles from './EmailView.module.css'
import { buildFrameDocument, EMAIL_FRAME_SANDBOX } from './htmlFrameDocument'

interface HtmlMessageBodyProps {
  /** Sanitized HTML from the main process. Never raw provider output. */
  html: string
}

/**
 * The frame is a separate document, so it inherits none of the app's theme
 * variables and has to be told which way to paint. `useTheme` stamps the
 * resolved mode onto the root element, which is read back here rather than
 * duplicating the preference logic.
 */
function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState(() => readIsDark())

  useEffect(() => {
    const observer = new MutationObserver(() => setDark(readIsDark()))
    observer.observe(window.document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme-mode']
    })

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onMediaChange = (): void => setDark(readIsDark())
    media.addEventListener('change', onMediaChange)

    return () => {
      observer.disconnect()
      media.removeEventListener('change', onMediaChange)
    }
  }, [])

  return dark
}

function readIsDark(): boolean {
  const mode = window.document.documentElement.getAttribute('data-theme-mode')
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Hard safety ceiling against pathological fixed-height email templates. */
const MAX_FRAME_HEIGHT = 20_000

/**
 * Renders an email's HTML body inside a locked-down iframe.
 *
 * The `sandbox` attribute omits `allow-scripts`, so the document cannot execute
 * anything or reach back into the app, and the injected CSP blocks every
 * network destination except the `data:` images that were already embedded
 * server-side. `allow-same-origin` lets this component measure the inert
 * document so the outer reader, rather than every message, owns scrolling.
 * `allow-popups` plus
 * `allow-popups-to-escape-sandbox` is the one capability granted, so that a
 * clicked link reaches the main process's window-open handler and opens in the
 * user's real browser rather than silently doing nothing.
 *
 * Height is measured from the loaded document because a sandboxed frame has no
 * intrinsic sizing — without this every message would render in a short,
 * awkwardly scrolling box.
 */
export function HtmlMessageBody({ html }: HtmlMessageBodyProps): JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(240)
  const [showRemote, setShowRemote] = useState(false)
  const dark = useIsDarkTheme()

  const hasRemoteImages = useMemo(() => html.includes('data-remote-src='), [html])

  const document = useMemo(
    () => buildFrameDocument(html, { dark, showRemote }),
    [html, dark, showRemote]
  )

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return

    let observer: ResizeObserver | null = null

    const measure = (): void => {
      const frameDocument = frame.contentDocument
      const body = frameDocument?.body
      const root = frameDocument?.documentElement
      if (!body || !root) return
      const next = Math.min(Math.max(body.scrollHeight, root.scrollHeight) + 2, MAX_FRAME_HEIGHT)
      setHeight((current) => (Math.abs(current - next) > 2 ? next : current))
    }

    const beginObserving = (): void => {
      observer?.disconnect()
      measure()
      const body = frame.contentDocument?.body
      if (!body) return
      observer = new ResizeObserver(measure)
      observer.observe(body)
    }

    frame.addEventListener('load', beginObserving)
    if (frame.contentDocument?.readyState === 'complete') beginObserving()
    // A few delayed reads cover image and font layout in clients where a
    // ResizeObserver notification is coalesced during iframe load.
    const timers = [80, 300, 900, 2_000].map((delay) => window.setTimeout(measure, delay))
    return () => {
      frame.removeEventListener('load', beginObserving)
      observer?.disconnect()
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [document])

  return (
    <div className={styles.htmlBody}>
      {hasRemoteImages && !showRemote && (
        <div className={styles.remoteNotice}>
          <Icon name="image" size={14} />
          <span>Images from the sender are blocked — loading them tells them you opened this.</span>
          <button type="button" className={styles.inlineLink} onClick={() => setShowRemote(true)}>
            Load images
          </button>
        </div>
      )}
      <iframe
        ref={frameRef}
        className={styles.htmlFrame}
        style={{ height }}
        title="Email message"
        sandbox={EMAIL_FRAME_SANDBOX}
        srcDoc={document}
      />
    </div>
  )
}
