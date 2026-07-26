import { createLogger } from '../utils/logger'

const log = createLogger('email:images')

/**
 * Fetches the images an email wanted to load from the network, and hands them
 * back as `data:` URIs.
 *
 * The renderer cannot do this itself, and the reason is worth writing down.
 * Message bodies render in a `srcdoc` iframe, and a `srcdoc` document
 * *inherits* its parent's Content-Security-Policy — a policy it can only ever
 * tighten, never relax. The app's own policy is `img-src 'self' data:`, so no
 * `img-src` the frame declares can re-permit `https:`, and every remote image
 * was refused however loudly the frame asked for it.
 *
 * Widening the app's policy would have fixed it in one line and opened an
 * exfiltration channel out of the whole renderer. Fetching here instead keeps
 * that policy shut: the images arrive as `data:` URIs, which the frame already
 * allows, and the request is made by the process that makes every other
 * request in this app.
 *
 * The privacy cost is unchanged and is the reader's to accept — a remote image
 * in an email is a tracking pixel more often than it is a picture, which is
 * what the notice above the message says before any of this runs.
 */

/** Per-image ceiling. Above this it is a payload, not a picture. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** Ceiling for one message, since every byte here ends up inlined in the DOM. */
const MAX_TOTAL_BYTES = 25 * 1024 * 1024

/** How many images one message may pull. A newsletter can reference hundreds. */
const MAX_IMAGES = 120

const REQUEST_TIMEOUT_MS = 15_000

/** Content types worth putting in an `<img>`; anything else is not an image. */
const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml'
])

/**
 * Resolves each URL to a `data:` URI. Anything that fails is simply absent
 * from the result, which leaves that one image blocked rather than failing the
 * whole message.
 */
export async function loadRemoteImages(urls: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(urls.filter((url) => isFetchable(url)))].slice(0, MAX_IMAGES)
  const resolved: Record<string, string> = {}
  let total = 0

  // Sequential rather than parallel: a newsletter can name a hundred images,
  // and opening a hundred sockets at once to a tracking domain is both rude
  // and a reliable way to get rate-limited into failing them all.
  for (const url of unique) {
    if (total >= MAX_TOTAL_BYTES) {
      log.warn(`Stopped loading images for one message at ${total} bytes.`)
      break
    }
    const image = await fetchImage(url)
    if (!image) continue
    total += image.bytes
    resolved[url] = image.dataUri
  }

  return resolved
}

function isFetchable(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    // Relative URLs, `cid:` references the message never supplied, and outright
    // junk all land here. None of them are things to go to the network for.
    return false
  }
}

async function fetchImage(url: string): Promise<{ dataUri: string; bytes: number } | null> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'image/*',
        // No cookies are sent (fetch defaults to omit here), and no referrer
        // is offered, so the sender learns the message was opened and nothing
        // further about where from.
        'User-Agent': 'Anodex'
      }
    })
    if (!response.ok) return null

    const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!ALLOWED_TYPES.has(mimeType)) return null

    // Checked before reading where the server declares it, and again after,
    // since `content-length` is a claim rather than a guarantee.
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) return null

    return {
      dataUri: `data:${mimeType};base64,${buffer.toString('base64')}`,
      bytes: buffer.byteLength
    }
  } catch (error) {
    log.warn(`Could not load remote image ${url}:`, error)
    return null
  }
}
