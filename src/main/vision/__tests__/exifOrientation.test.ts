import { describe, expect, it } from 'vitest'
import { applyExifOrientation, readJpegOrientation, type Bitmap } from '../exifOrientation'

/**
 * Smallest JPEG that carries a real Exif APP1 segment with one IFD0 entry.
 * `little` picks the TIFF byte order, since cameras ship both.
 */
function jpegWithOrientation(value: number, little = true): Buffer {
  const tiff = Buffer.alloc(26)
  tiff.write(little ? 'II' : 'MM', 0, 'ascii')
  if (little) {
    tiff.writeUInt16LE(0x002a, 2)
    tiff.writeUInt32LE(8, 4)
    tiff.writeUInt16LE(1, 8) // one entry
    tiff.writeUInt16LE(0x0112, 10) // orientation tag
    tiff.writeUInt16LE(3, 12) // SHORT
    tiff.writeUInt32LE(1, 14)
    tiff.writeUInt16LE(value, 18)
  } else {
    tiff.writeUInt16BE(0x002a, 2)
    tiff.writeUInt32BE(8, 4)
    tiff.writeUInt16BE(1, 8)
    tiff.writeUInt16BE(0x0112, 10)
    tiff.writeUInt16BE(3, 12)
    tiff.writeUInt32BE(1, 14)
    tiff.writeUInt16BE(value, 18)
  }

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff])
  const segment = Buffer.alloc(4)
  segment.writeUInt16BE(0xffe1, 0)
  segment.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment, payload, Buffer.from([0xff, 0xd9])])
}

/** A 2x1 bitmap whose two pixels are distinguishable by their blue channel. */
function twoByOne(): Bitmap {
  return {
    data: Buffer.from([1, 0, 0, 255, 2, 0, 0, 255]),
    width: 2,
    height: 1
  }
}

describe('readJpegOrientation', () => {
  it('reads the tag a phone camera writes for a sideways capture', () => {
    expect(readJpegOrientation(jpegWithOrientation(6))).toBe(6)
  })

  it('reads big-endian TIFF blocks too', () => {
    expect(readJpegOrientation(jpegWithOrientation(8, false))).toBe(8)
  })

  it('answers 1 for a JPEG with no Exif segment', () => {
    expect(readJpegOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(1)
  })

  it('answers 1 rather than throwing on truncated or non-JPEG input', () => {
    expect(readJpegOrientation(Buffer.alloc(0))).toBe(1)
    expect(readJpegOrientation(Buffer.from('not an image'))).toBe(1)
    expect(readJpegOrientation(jpegWithOrientation(6).subarray(0, 12))).toBe(1)
  })

  it('answers 1 for an out-of-range tag value', () => {
    expect(readJpegOrientation(jpegWithOrientation(99))).toBe(1)
  })

  it('stops at the start of scan instead of reading pixel data as metadata', () => {
    const sos = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xe1])
    expect(readJpegOrientation(sos)).toBe(1)
  })
})

describe('applyExifOrientation', () => {
  it('returns the same buffer untouched when the image is already upright', () => {
    const bitmap = twoByOne()
    expect(applyExifOrientation(bitmap, 1)).toBe(bitmap)
  })

  it('swaps width and height for the quarter-turn orientations', () => {
    const rotated = applyExifOrientation(twoByOne(), 6)

    expect(rotated.width).toBe(1)
    expect(rotated.height).toBe(2)
  })

  it('moves the leading pixel where a 90-degree clockwise turn puts it', () => {
    // Stored left-to-right as [1, 2]; upright that reads top-to-bottom as [1, 2].
    const rotated = applyExifOrientation(twoByOne(), 6)

    expect([rotated.data[0], rotated.data[4]]).toEqual([1, 2])
  })

  it('reverses the row for a 180-degree turn, keeping the dimensions', () => {
    const rotated = applyExifOrientation(twoByOne(), 3)

    expect(rotated.width).toBe(2)
    expect(rotated.height).toBe(1)
    expect([rotated.data[0], rotated.data[4]]).toEqual([2, 1])
  })

  it('mirrors without rotating for the flip-only orientation', () => {
    const flipped = applyExifOrientation(twoByOne(), 2)

    expect(flipped.width).toBe(2)
    expect([flipped.data[0], flipped.data[4]]).toEqual([2, 1])
  })

  it('keeps every pixel exactly once through a full turn of quarter rotations', () => {
    const source: Bitmap = {
      data: Buffer.from(Array.from({ length: 6 }, (_, index) => [index + 1, 0, 0, 255]).flat()),
      width: 3,
      height: 2
    }

    let bitmap = source
    for (let turn = 0; turn < 4; turn++) bitmap = applyExifOrientation(bitmap, 6)

    expect(bitmap.width).toBe(3)
    expect(bitmap.height).toBe(2)
    expect(bitmap.data).toEqual(source.data)
  })
})
