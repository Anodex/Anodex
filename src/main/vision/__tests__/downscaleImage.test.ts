import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatImageInput } from '@shared/chat.types'

const createFromBuffer = vi.fn<(data: Buffer) => unknown>()
const createFromBitmap = vi.fn<(data: Buffer, size: { width: number; height: number }) => unknown>()

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: (data: Buffer) => createFromBuffer(data),
    createFromBitmap: (data: Buffer, size: { width: number; height: number }) =>
      createFromBitmap(data, size)
  }
}))

import { downscaleForVision } from '../downscaleImage'

/** A decoded image as Chromium would hand it back, with a stubbed re-encode. */
function fakeDecoded(options: {
  width: number
  height: number
  encoded: Buffer
  onResize?: (size: { width?: number; height?: number }) => void
}): unknown {
  const result = {
    isEmpty: () => false,
    getSize: () => ({ width: options.width, height: options.height }),
    resize: (size: { width?: number; height?: number }) => {
      options.onResize?.(size)
      return result
    },
    toBitmap: () => Buffer.alloc(options.width * options.height * 4),
    toPNG: () => options.encoded,
    toJPEG: () => options.encoded
  }
  return result
}

/** A JPEG carrying just enough Exif to declare a sideways capture. */
function jpegWithOrientation(value: number): Buffer {
  const tiff = Buffer.alloc(26)
  tiff.write('II', 0, 'ascii')
  tiff.writeUInt16LE(0x002a, 2)
  tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(1, 8)
  tiff.writeUInt16LE(0x0112, 10)
  tiff.writeUInt16LE(3, 12)
  tiff.writeUInt32LE(1, 14)
  tiff.writeUInt16LE(value, 18)

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff])
  const segment = Buffer.alloc(4)
  segment.writeUInt16BE(0xffe1, 0)
  segment.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment, payload, Buffer.from([0xff, 0xd9])])
}

function image(overrides: Partial<ChatImageInput> = {}): ChatImageInput {
  return {
    path: 'photo.jpg',
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 5_200_000,
    dataUrl: 'data:image/jpeg;base64,original',
    ...overrides
  }
}

describe('downscaleForVision', () => {
  beforeEach(() => {
    createFromBuffer.mockReset()
    createFromBitmap.mockReset()
    createFromBitmap.mockImplementation(() =>
      fakeDecoded({ width: 1, height: 1, encoded: Buffer.from('upright') })
    )
  })

  it('bakes in the rotation a sideways phone photo only declared in Exif', () => {
    // The bug this prevents: nativeImage decodes stored pixels without applying
    // orientation, and re-encoding drops the tag — so the model is handed a
    // photo lying on its side and describes it that way.
    createFromBuffer.mockReturnValue(
      fakeDecoded({ width: 4032, height: 3024, encoded: Buffer.from('x') })
    )

    const result = downscaleForVision(image(), jpegWithOrientation(6))

    expect(createFromBitmap).toHaveBeenCalledOnce()
    expect(result.dataUrl).toContain(Buffer.from('upright').toString('base64'))
  })

  it('rotates a small photo too, since size has nothing to do with which way is up', () => {
    createFromBuffer.mockReturnValue(
      fakeDecoded({ width: 600, height: 800, encoded: Buffer.from('x') })
    )
    const original = image({ sizeBytes: 40_000 })

    const result = downscaleForVision(original, jpegWithOrientation(8))

    expect(result).not.toBe(original)
    expect(createFromBitmap).toHaveBeenCalledOnce()
  })

  it('leaves the pixels of an upright photo alone', () => {
    createFromBuffer.mockReturnValue(
      fakeDecoded({ width: 4032, height: 3024, encoded: Buffer.from('small') })
    )

    downscaleForVision(image(), jpegWithOrientation(1))

    expect(createFromBitmap).not.toHaveBeenCalled()
  })

  it('shrinks a phone photo to the long edge and re-encodes it', () => {
    const onResize = vi.fn()
    createFromBuffer.mockReturnValue(
      fakeDecoded({ width: 4032, height: 3024, encoded: Buffer.from('small'), onResize })
    )

    const result = downscaleForVision(image(), Buffer.alloc(5_200_000))

    expect(onResize).toHaveBeenCalledWith({ width: 1568, quality: 'good' })
    expect(result.sizeBytes).toBe('small'.length)
    expect(result.dataUrl).toBe(`data:image/jpeg;base64,${Buffer.from('small').toString('base64')}`)
  })

  it('constrains the height instead when the image is taller than it is wide', () => {
    const onResize = vi.fn()
    createFromBuffer.mockReturnValue(
      fakeDecoded({ width: 3024, height: 4032, encoded: Buffer.from('small'), onResize })
    )

    downscaleForVision(image(), Buffer.alloc(5_200_000))

    expect(onResize).toHaveBeenCalledWith({ height: 1568, quality: 'good' })
  })

  it('leaves a small image exactly as it arrived', () => {
    createFromBuffer.mockReturnValue(
      fakeDecoded({ width: 800, height: 600, encoded: Buffer.from('x') })
    )
    const original = image({ sizeBytes: 40_000 })

    expect(downscaleForVision(original, Buffer.alloc(40_000))).toBe(original)
  })

  it('re-encodes an in-bounds image that is still too many bytes', () => {
    createFromBuffer.mockReturnValue(
      fakeDecoded({ width: 1200, height: 900, encoded: Buffer.from('smaller') })
    )

    const result = downscaleForVision(image({ sizeBytes: 4_000_000 }), Buffer.alloc(4_000_000))

    expect(result.sizeBytes).toBe('smaller'.length)
  })

  it('keeps the original when re-encoding would not save anything', () => {
    createFromBuffer.mockReturnValue(
      fakeDecoded({ width: 4032, height: 3024, encoded: Buffer.alloc(9_000_000) })
    )
    const original = image()

    expect(downscaleForVision(original, Buffer.alloc(5_200_000))).toBe(original)
  })

  it('passes through formats Chromium will not decode here', () => {
    const original = image({ name: 'clip.gif', mimeType: 'image/gif' })

    expect(downscaleForVision(original, Buffer.alloc(9_000_000))).toBe(original)
    expect(createFromBuffer).not.toHaveBeenCalled()
  })

  it('returns the original rather than failing when decoding does not work', () => {
    createFromBuffer.mockReturnValue({ isEmpty: () => true })
    const original = image()

    expect(downscaleForVision(original, Buffer.alloc(5_200_000))).toBe(original)
  })

  it('survives a decoder that throws', () => {
    createFromBuffer.mockImplementation(() => {
      throw new Error('decode failed')
    })
    const original = image()

    expect(downscaleForVision(original, Buffer.alloc(5_200_000))).toBe(original)
  })
})
