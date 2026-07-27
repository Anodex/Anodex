import { nativeImage } from 'electron'
import type { ChatImageInput } from '@shared/chat.types'
import { createLogger } from '../utils/logger'
import { applyExifOrientation, needsReorientation, readJpegOrientation } from './exifOrientation'

const log = createLogger('vision:downscale')

/**
 * Longest edge kept when an image has to shrink. Vision models tile their input
 * at roughly this scale and discard the rest, so pixels past it cost tokens and
 * bandwidth without adding anything the model can actually resolve.
 */
const MAX_EDGE = 1568

/**
 * Above this, re-encode even a correctly-sized image. Cloud vision APIs reject
 * a single image over ~5MB outright, and the local transport pays for every
 * byte in context — so the cap has to sit well under the 15MB ceiling that
 * merely bounds decoding.
 */
const MAX_BYTES = 1024 * 1024

/** Formats Chromium will decode here. Others pass through untouched. */
const RESIZABLE = new Set(['image/png', 'image/jpeg'])

/**
 * Prepare an image for a model: upright, and small enough to send.
 *
 * Workspace inspection never needed either half — it captures at a fixed
 * 1280x800 from a browser that already applied orientation. An email attachment
 * is whatever the sender's phone produced: routinely a 4000px, multi-megabyte
 * JPEG whose pixels are stored sideways behind an EXIF tag. Too large for a
 * cloud request to be accepted at all, enough to crowd out a local model's
 * context, and — once re-encoded without that tag — sideways for good.
 *
 * Rotation is applied whatever the size, because a small photo is just as
 * sideways as a large one. Resizing happens first so the pixel shuffle runs
 * over the smaller buffer.
 *
 * Best-effort by design. Anything that cannot be decoded is returned exactly as
 * it arrived — a picture the model can see at full size beats a hard failure,
 * and the 15MB validation cap still applies upstream.
 */
export function downscaleForVision(image: ChatImageInput, data: Buffer): ChatImageInput {
  const mimeType = image.mimeType.toLowerCase()
  if (!RESIZABLE.has(mimeType)) return image

  try {
    // Only JPEG carries orientation in practice; PNG has no equivalent that
    // decoders or viewers act on.
    const orientation = mimeType === 'image/jpeg' ? readJpegOrientation(data) : 1
    const mustReorient = needsReorientation(orientation)

    const decoded = nativeImage.createFromBuffer(data)
    if (decoded.isEmpty()) return image

    const { width, height } = decoded.getSize()
    const longest = Math.max(width, height)
    const mustResize = longest > MAX_EDGE || data.length > MAX_BYTES
    if (!mustResize && !mustReorient) return image

    let working =
      longest > MAX_EDGE
        ? decoded.resize(
            width >= height
              ? { width: MAX_EDGE, quality: 'good' }
              : { height: MAX_EDGE, quality: 'good' }
          )
        : decoded

    if (mustReorient) {
      const size = working.getSize()
      const upright = applyExifOrientation(
        { data: working.toBitmap(), width: size.width, height: size.height },
        orientation
      )
      working = nativeImage.createFromBitmap(upright.data, {
        width: upright.width,
        height: upright.height
      })
    }

    // PNG stays PNG: it is the format screenshots and diagrams arrive in, and
    // re-encoding crisp text as JPEG is exactly where that content degrades.
    const encoded = mimeType === 'image/png' ? working.toPNG() : working.toJPEG(85)
    if (encoded.length <= 0) return image
    // Insist on a size win only when shrinking was the whole point. A rotation
    // that costs a few bytes still produces the right picture.
    if (!mustReorient && encoded.length >= data.length) return image

    return {
      ...image,
      sizeBytes: encoded.length,
      dataUrl: `data:${mimeType};base64,${encoded.toString('base64')}`
    }
  } catch (error) {
    log.warn(`Could not prepare "${image.name}" for vision:`, error)
    return image
  }
}
