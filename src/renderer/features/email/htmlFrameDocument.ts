/**
 * The frame shares an origin only so its React owner can read the rendered
 * height. It still cannot execute scripts: `allow-scripts` is absent from the
 * sandbox and the generated CSP also declares `script-src 'none'`.
 */
export const EMAIL_FRAME_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox'

/**
 * How far a message may be shrunk to fit the pane. Below this the text stops
 * being worth reading, and a message that wide is better off overflowing than
 * illegible.
 */
const MIN_FIT_SCALE = 0.55

/**
 * Scales an over-wide message down until it fits, and reports the height it
 * ends up occupying.
 *
 * Newsletters are laid out for a fixed-width desktop client — Reddit's digest
 * is built from tables with hard pixel widths — and the reader's column is
 * narrower than that. `max-width` cannot reach inside a table whose cells
 * carry `width` attributes, so the surplus used to disappear under the frame's
 * `overflow: hidden`: the right-hand edge of every wide message was simply
 * cut off, with nothing to say it had been.
 *
 * `zoom` rather than `transform: scale()` because zoom participates in layout,
 * so the document reflows to its scaled size and the height measured below is
 * the height actually occupied. A transform would leave the original box
 * behind and strand a gap under every scaled message.
 */
export function fitFrameContents(frame: HTMLIFrameElement, maxHeight: number): number | null {
  const frameDocument = frame.contentDocument
  const body = frameDocument?.body
  const root = frameDocument?.documentElement
  if (!body || !root) return null

  // Measured unscaled: the natural width is the question being asked, and a
  // zoom left over from the previous pass would answer it wrongly.
  body.style.zoom = ''
  const available = frame.clientWidth
  const natural = Math.max(body.scrollWidth, root.scrollWidth)

  const scale =
    available > 0 && natural > available ? Math.max(available / natural, MIN_FIT_SCALE) : 1
  if (scale < 1) body.style.zoom = String(scale)

  const height = Math.max(body.scrollHeight, root.scrollHeight)
  return Math.min(Math.ceil(height * scale) + 2, maxHeight)
}

/** Every remote image URL the message wanted, in document order. */
export function collectRemoteImageUrls(html: string): string[] {
  const urls: string[] = []
  for (const match of html.matchAll(/\sdata-remote-src\s*=\s*"([^"]*)"/gi)) {
    const url = decodeAttribute(match[1]).trim()
    if (url) urls.push(url)
  }
  return [...new Set(urls)]
}

/**
 * Swaps each parked URL for the `data:` URI fetched for it, leaving any that
 * could not be fetched parked — and therefore still hidden — rather than
 * pointing an `<img>` at something that will fail and draw a broken glyph.
 */
export function inlineRemoteImages(html: string, images: Record<string, string>): string {
  return html.replace(/\sdata-remote-src\s*=\s*"([^"]*)"/gi, (whole, raw: string) => {
    const resolved = images[decodeAttribute(raw).trim()]
    return resolved ? ` src="${resolved}"` : whole
  })
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function buildFrameDocument(
  html: string,
  options: { dark: boolean; images?: Record<string, string> }
): string {
  // Stays `data:` in both states. Remote images arrive already inlined as
  // `data:` URIs (see `main/email/remoteImages.ts`) because a `srcdoc` frame
  // inherits the app's `img-src 'self' data:` policy and can only tighten it —
  // naming `https:` here achieved nothing but a blocked request. `default-src
  // 'none'` means anything not listed — fetches, frames, fonts, media — is
  // refused outright.
  const csp = [
    "default-src 'none'",
    'img-src data:',
    "style-src 'unsafe-inline'",
    "font-src 'none'",
    "script-src 'none'"
  ].join('; ')

  const body = options.images ? inlineRemoteImages(html, options.images) : html

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
    height: auto !important;
    min-height: 0 !important;
    background: transparent;
    color: ${foreground};
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.6;
    overflow-wrap: anywhere;
    overflow: hidden !important;
  }
  /* Email HTML is written for fixed-width desktop clients. max-width reins in
     what it can, and anything still too wide — a table with hard width
     attributes on its cells, which is most newsletters — is scaled down to fit
     by fitFrameContents, because the alternative here is the overflow rule
     above silently cutting the right-hand side off the message. */
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
  /* A parked image has no src at all; hiding it stops the alt text and the
     broken-image glyph standing in for a picture the reader has not asked
     for yet. */
  img[data-remote-src] { visibility: hidden; }
</style>
</head>
<body>${body}</body>
</html>`
}
