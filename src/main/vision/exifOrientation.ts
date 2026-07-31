/**
 * EXIF orientation handling for images headed to a vision model.
 *
 * Phone cameras almost never rotate their sensor output. They store it as
 * captured and add an EXIF orientation tag saying which way is up, and every
 * *viewer* applies it — which is why a photo looks upright in a mail client
 * while its raw pixel rows are sideways.
 *
 * Decoders do not apply it. Chromium's `nativeImage` hands back the stored
 * pixels, and re-encoding drops the tag, so a downscale pass silently turns
 * "sideways pixels plus a note" into "permanently sideways". A model then
 * spends its answer describing a rotated photo instead of the subject. These
 * helpers exist to bake the rotation into the pixels while the tag is still
 * known.
 */

/** The eight EXIF orientations; 1 is "already upright". */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

const JPEG_START = 0xffd8
const APP1 = 0xffe1
const ORIENTATION_TAG = 0x0112

/**
 * Read the orientation tag out of a JPEG, or 1 when there is none.
 *
 * Deliberately total: every malformed, truncated, or simply tag-less input
 * answers 1 rather than throwing. A picture shown the way it was stored is a
 * far better failure than no picture at all.
 */
export function readJpegOrientation(data: Buffer): ExifOrientation {
  if (data.length < 4 || data.readUInt16BE(0) !== JPEG_START) return 1

  let offset = 2
  // Walk the segment chain looking for APP1/Exif. Segments carry their own
  // length, so this never has to guess where the next marker begins.
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) return 1
    const marker = data.readUInt16BE(offset)
    const length = data.readUInt16BE(offset + 2)
    if (length < 2) return 1

    if (marker === APP1 && data.toString('ascii', offset + 4, offset + 10) === 'Exif\0\0') {
      return readTiffOrientation(data, offset + 10, offset + 2 + length)
    }
    // Start of scan: image data follows, and no metadata comes after it.
    if (marker === 0xffda) return 1
    offset += 2 + length
  }
  return 1
}

/** Parse IFD0 of the TIFF block an Exif APP1 segment wraps. */
function readTiffOrientation(data: Buffer, start: number, end: number): ExifOrientation {
  if (start + 8 > end || start + 8 > data.length) return 1

  const byteOrder = data.toString('ascii', start, start + 2)
  if (byteOrder !== 'II' && byteOrder !== 'MM') return 1
  const little = byteOrder === 'II'
  const u16 = (at: number): number => (little ? data.readUInt16LE(at) : data.readUInt16BE(at))
  const u32 = (at: number): number => (little ? data.readUInt32LE(at) : data.readUInt32BE(at))

  const ifdOffset = start + u32(start + 4)
  if (ifdOffset + 2 > end || ifdOffset + 2 > data.length) return 1

  const entries = u16(ifdOffset)
  for (let index = 0; index < entries; index++) {
    const entry = ifdOffset + 2 + index * 12
    if (entry + 12 > end || entry + 12 > data.length) return 1
    if (u16(entry) !== ORIENTATION_TAG) continue
    const value = u16(entry + 8)
    return value >= 1 && value <= 8 ? (value as ExifOrientation) : 1
  }
  return 1
}

export interface Bitmap {
  data: Buffer
  width: number
  height: number
}

/** True when the orientation actually moves pixels around. */
export function needsReorientation(orientation: ExifOrientation): boolean {
  return orientation !== 1
}

/**
 * Rewrite a raw BGRA bitmap so the stored pixels are the upright ones.
 *
 * Orientations 5-8 transpose the image, so width and height come back swapped —
 * callers must rebuild the image from the returned dimensions rather than the
 * ones they passed in.
 */
export function applyExifOrientation(bitmap: Bitmap, orientation: ExifOrientation): Bitmap {
  if (!needsReorientation(orientation)) return bitmap

  const { data, width, height } = bitmap
  const transposed = orientation >= 5
  const outWidth = transposed ? height : width
  const outHeight = transposed ? width : height
  const out = Buffer.allocUnsafe(outWidth * outHeight * 4)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [outX, outY] = mapPixel(orientation, x, y, width, height)
      data.copy(out, (outY * outWidth + outX) * 4, (y * width + x) * 4, (y * width + x) * 4 + 4)
    }
  }

  return { data: out, width: outWidth, height: outHeight }
}

/** Where a stored pixel belongs once the orientation is applied. */
function mapPixel(
  orientation: ExifOrientation,
  x: number,
  y: number,
  width: number,
  height: number
): [number, number] {
  switch (orientation) {
    case 2:
      return [width - 1 - x, y]
    case 3:
      return [width - 1 - x, height - 1 - y]
    case 4:
      return [x, height - 1 - y]
    case 5:
      return [y, x]
    case 6:
      return [height - 1 - y, x]
    case 7:
      return [height - 1 - y, width - 1 - x]
    case 8:
      return [y, width - 1 - x]
    default:
      return [x, y]
  }
}
