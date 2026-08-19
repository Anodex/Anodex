/**
 * Downscale a chosen avatar before it is stored.
 *
 * ## Why
 *
 * The avatar lives in `settings.json` as a data URL, and nothing bounded it.
 * One real profile picture put a **2.4 MB** base64 PNG in there, which made the
 * settings file 2.4 MB — and settings are rewritten in full on every change, so
 * dragging the temperature slider rewrote megabytes per step. It also made the
 * file slow enough to read that it could still hold stale values moments after
 * a change, which is confusing to debug and risks more loss if the app is
 * killed mid-write.
 *
 * The picture is shown at roughly 32px in the sidebar and 64px in settings.
 * Storing it at {@link AVATAR_MAX_EDGE} keeps it sharp on a high-DPI display at
 * both sizes and costs a few kilobytes. The user still picks any image they
 * like; only what Anodex keeps on disk changes.
 */

/** Longest edge kept, in CSS pixels. Comfortably retina for a 64px avatar. */
export const AVATAR_MAX_EDGE = 256

/**
 * JPEG rather than PNG: an avatar is a photograph far more often than line art,
 * and PNG stores photographs several times larger for no visible gain here.
 */
const AVATAR_MIME = 'image/jpeg'
const AVATAR_QUALITY = 0.9

/**
 * Re-encode a data URL to a square-bounded, downscaled avatar.
 *
 * Returns the original string unchanged if it cannot be decoded — a stored
 * avatar that fails to load is the user's picture, and losing it to be tidy is
 * worse than keeping it oversized.
 */
export async function downscaleAvatar(dataUrl: string): Promise<string> {
  const image = await loadImage(dataUrl).catch(() => null)
  if (!image || image.naturalWidth === 0 || image.naturalHeight === 0) return dataUrl

  const scale = Math.min(1, AVATAR_MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight))
  if (scale === 1 && dataUrl.length <= AVATAR_MAX_STORED_CHARS) return dataUrl

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) return dataUrl
  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  const encoded = canvas.toDataURL(AVATAR_MIME, AVATAR_QUALITY)
  // Only take the re-encode if it actually helped. A small PNG icon can grow
  // when pushed through JPEG, and storing the larger one would defeat the point.
  return encoded.length < dataUrl.length ? encoded : dataUrl
}

/**
 * Size past which a stored avatar is worth re-encoding even when its pixel
 * dimensions are already small — an over-compressed source can still be large.
 */
export const AVATAR_MAX_STORED_CHARS = 128 * 1024

/** Whether a stored avatar is large enough to be worth normalising on load. */
export function avatarNeedsDownscale(dataUrl: string | null | undefined): boolean {
  return typeof dataUrl === 'string' && dataUrl.length > AVATAR_MAX_STORED_CHARS
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Could not decode the selected image.'))
    image.src = dataUrl
  })
}
