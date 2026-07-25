import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import styles from './EmailView.module.css'

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

/** Upper bound on the auto-sized frame, so one long newsletter can't fill the view. */
const MAX_FRAME_HEIGHT = 900

/**
 * Renders an email's HTML body inside a locked-down iframe.
 *
 * The `sandbox` attribute omits both `allow-scripts` and `allow-same-origin`,
 * so the document cannot execute anything or reach back into the app, and the
 * injected CSP blocks every network destination except the `data:` images that
 * were already embedded server-side. `allow-popups` plus
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

    const measure = (): void => {
      const body = frame.contentDocument?.body
      if (!body) return
      const next = Math.min(body.scrollHeight + 16, MAX_FRAME_HEIGHT)
      setHeight((current) => (Math.abs(current - next) > 2 ? next : current))
    }

    frame.addEventListener('load', measure)
    // Images finishing later change the height, and a sandboxed document can't
    // tell us itself, so poll briefly after load rather than measuring once.
    const timers = [80, 300, 900].map((delay) => window.setTimeout(measure, delay))
    return () => {
      frame.removeEventListener('load', measure)
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
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={document}
      />
    </div>
  )
}

function buildFrameDocument(html: string, options: { dark: boolean; showRemote: boolean }): string {
  // `img-src` widens to remote hosts only after an explicit opt-in, and script
  // sources stay disallowed either way. `default-src 'none'` means anything not
  // named here — fetches, frames, fonts, media — is refused outright.
  const imgSrc = options.showRemote ? 'data: https: http:' : 'data:'
  const csp = [
    "default-src 'none'",
    `img-src ${imgSrc}`,
    "style-src 'unsafe-inline'",
    "font-src 'none'",
    "script-src 'none'"
  ].join('; ')

  const restoreRemote = options.showRemote
    ? `<style>img[data-remote-src]{visibility:visible}</style>`
    : ''

  const body = options.showRemote ? html.replace(/\sdata-remote-src=/gi, ' src=') : html

  const foreground = options.dark ? '#e8ebf0' : '#1a1d23'
  const muted = options.dark ? '#9aa3b2' : '#5b6472'
  const link = options.dark ? '#7aa7ff' : '#2f6fed'

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    color: ${foreground};
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  /* Email HTML is written for fixed-width desktop clients and will otherwise
     force horizontal scrolling inside the panel. */
  img, table, video { max-width: 100% !important; height: auto; }
  table { border-collapse: collapse; }
  a { color: ${link}; }
  blockquote {
    margin: 0 0 0 8px;
    padding-left: 12px;
    border-left: 2px solid ${muted};
    color: ${muted};
  }
  pre { white-space: pre-wrap; }
  /* A blocked remote image would otherwise show a broken-image glyph. */
  img[data-remote-src] { visibility: hidden; }
</style>
${restoreRemote}
</head>
<body>${body}</body>
</html>`
}
