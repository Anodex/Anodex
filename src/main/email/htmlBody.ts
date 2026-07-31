/**
 * Prepares an HTML email body for display.
 *
 * Email HTML is fully untrusted: it arrives from strangers and routinely
 * contains tracking pixels, and historically has carried script payloads. Two
 * independent defenses apply, and neither is trusted alone:
 *
 *  1. This module strips anything executable before the HTML leaves the main
 *     process — script/style/frame elements, `on*` handlers, and scheme-based
 *     script URLs.
 *  2. The renderer displays the result inside a sandboxed iframe with no
 *     scripting and a restrictive CSP (see `EmailView`). That sandbox is the
 *     real guarantee; the stripping here is defense in depth, because
 *     regex-based HTML rewriting can never be provably complete.
 *
 * Remote images are deliberately *not* loaded. A remote `<img>` in an email is
 * usually a tracking pixel that tells the sender the message was opened and
 * leaks the reader's IP. Their URLs are parked on `data-remote-src` so the
 * reader can opt in per message, which is what every mainstream mail client
 * does. Inline `cid:` images have already been delivered with the message, so
 * they carry no such signal and are embedded directly.
 */

/** An image delivered as part of the message, referenced by `cid:` in the HTML. */
export interface InlineImage {
  contentId: string
  mimeType: string
  data: Buffer
}

/** Ceiling on embedded image bytes, so one image-heavy email can't bloat the IPC payload. */
const MAX_INLINE_TOTAL_BYTES = 8 * 1024 * 1024

/**
 * Elements removed outright, contents included.
 *
 * `<style>` is deliberately *not* here. Stripping it flattens most newsletters
 * into unstyled text, and CSS cannot execute — the one thing it could do is
 * fetch a remote `url()`, which the frame's `default-src 'none'` /
 * `img-src data:` policy already refuses until the reader loads images anyway.
 */
const STRIPPED_ELEMENTS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'noscript'
]

/** Void/standalone elements removed without a closing tag to match. */
const STRIPPED_VOID_ELEMENTS = ['link', 'meta', 'base']

export function sanitizeEmailHtml(html: string, inline: readonly InlineImage[] = []): string {
  let output = html

  for (const tag of STRIPPED_ELEMENTS) {
    output = output.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi'), '')
    // An unclosed instance would otherwise survive the paired pattern above.
    output = output.replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), '')
  }
  for (const tag of STRIPPED_VOID_ELEMENTS) {
    output = output.replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), '')
  }

  // Inline event handlers: on<name>= followed by a quoted or bare value.
  output = output.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
  output = output.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
  output = output.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')

  // Scheme-based script execution in any attribute value.
  output = output.replace(
    /(href|src|action|background|formaction)\s*=\s*"(\s*(?:javascript|vbscript|data:text\/html)[^"]*)"/gi,
    '$1="#"'
  )
  output = output.replace(
    /(href|src|action|background|formaction)\s*=\s*'(\s*(?:javascript|vbscript|data:text\/html)[^']*)'/gi,
    "$1='#'"
  )

  output = embedInlineImages(output, inline)
  output = deferRemoteImages(output)
  output = hardenLinks(output)

  return output.trim()
}

/**
 * Swaps `cid:` references for data URIs. These bytes already travelled with the
 * message, so showing them reveals nothing to the sender that opening the mail
 * did not already reveal.
 */
function embedInlineImages(html: string, inline: readonly InlineImage[]): string {
  if (inline.length === 0) return html

  const byId = new Map<string, InlineImage>()
  let budget = MAX_INLINE_TOTAL_BYTES
  for (const image of inline) {
    if (image.data.length > budget) continue
    budget -= image.data.length
    byId.set(normalizeContentId(image.contentId), image)
  }
  if (byId.size === 0) return html

  return html.replace(/(["'])cid:([^"']+)\1/gi, (match, quote: string, rawId: string) => {
    const image = byId.get(normalizeContentId(rawId))
    if (!image) return match
    return `${quote}data:${image.mimeType};base64,${image.data.toString('base64')}${quote}`
  })
}

/**
 * Parks remote image URLs on `data-remote-src` and removes `src`, so nothing is
 * requested until the reader explicitly asks for it.
 */
function deferRemoteImages(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = tag.match(/\ssrc\s*=\s*("([^"]*)"|'([^']*)')/i)
    if (!src) return tag
    const url = (src[2] ?? src[3] ?? '').trim()
    // Already-embedded images need no deferral — they cost no network request.
    if (url.startsWith('data:')) return tag
    return tag.replace(src[0], ` data-remote-src="${escapeAttribute(url)}"`)
  })
}

/** Links open in the real browser, never inside the app, and leak no referrer. */
function hardenLinks(html: string): string {
  return html.replace(/<a\b([^>]*)>/gi, (_match, attrs: string) => {
    const cleaned = attrs
      .replace(/\starget\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\srel\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    return `<a${cleaned} target="_blank" rel="noopener noreferrer">`
  })
}

/** `Content-ID` headers are angle-bracketed; the `cid:` URL form is not. */
function normalizeContentId(value: string): string {
  return value.replace(/[<>]/g, '').trim().toLowerCase()
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** True when a body has enough markup to be worth rendering as HTML at all. */
export function looksLikeHtml(value: string): boolean {
  return /<(?:html|body|div|table|p|br|img|a|span|h[1-6])\b/i.test(value)
}
