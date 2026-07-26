import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { anodex } from '../../lib/anodex'
import { notifyError } from '../../stores/uiStore'
import styles from './EmailView.module.css'
import {
  buildFrameDocument,
  collectRemoteImageUrls,
  EMAIL_FRAME_SANDBOX,
  fitFrameContents
} from './htmlFrameDocument'

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
  const [images, setImages] = useState<Record<string, string> | null>(null)
  const [loading, setLoading] = useState(false)
  const dark = useIsDarkTheme()

  const remoteUrls = useMemo(() => collectRemoteImageUrls(html), [html])

  const document = useMemo(
    () => buildFrameDocument(html, { dark, images: images ?? undefined }),
    [html, dark, images]
  )

  /**
   * The fetch happens in the main process, not here: this frame inherits the
   * app's `img-src 'self' data:` policy and cannot widen it, so a remote URL
   * in an `<img>` is refused no matter what. What comes back is already a
   * `data:` URI, which the policy has always allowed.
   */
  const loadImages = async (): Promise<void> => {
    setLoading(true)
    try {
      const result = await anodex.email.loadRemoteImages(remoteUrls)
      // An empty map still counts as answered — every image failed, and the
      // notice should stop offering to try what has just been tried.
      setImages(result.ok ? result.value : {})
      if (!result.ok) {
        notifyError('Could not load the images', result.error.detail ?? result.error.message)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return

    let observer: ResizeObserver | null = null

    const measure = (): void => {
      const next = fitFrameContents(frame, MAX_FRAME_HEIGHT)
      if (next === null) return
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
      {remoteUrls.length > 0 && images === null && (
        <div className={styles.remoteNotice}>
          <Icon name="image" size={14} />
          <span>
            {remoteUrls.length} image{remoteUrls.length === 1 ? '' : 's'} from the sender{' '}
            {remoteUrls.length === 1 ? 'is' : 'are'} blocked — loading{' '}
            {remoteUrls.length === 1 ? 'it' : 'them'} tells them you opened this.
          </span>
          <button
            type="button"
            className={styles.inlineLink}
            disabled={loading}
            onClick={() => void loadImages()}
          >
            {loading ? 'Loading…' : 'Load images'}
          </button>
        </div>
      )}
      {/* Said plainly rather than left as a row of gaps: an image the sender's
          host refused is not the same as one the reader chose to block. */}
      {images !== null && Object.keys(images).length < remoteUrls.length && (
        <div className={styles.remoteNotice}>
          <Icon name="alert" size={14} />
          <span>
            {remoteUrls.length - Object.keys(images).length} of {remoteUrls.length} images could not
            be loaded.
          </span>
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
