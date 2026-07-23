import { describe, expect, it } from 'vitest'
import {
  hasExpectedImageSignature,
  imageMimeType,
  isImagePath,
  isLikelyBinary
} from '../attachments.handlers'

describe('isImagePath', () => {
  it('recognizes common raster image extensions', () => {
    for (const path of ['photo.png', 'photo.JPG', 'a/b/image.bmp', 'anim.gif']) {
      expect(isImagePath(path)).toBe(true)
    }
  })

  it('does not pass formats that llama.cpp cannot decode through stb_image', () => {
    for (const path of ['icon.ico', 'shot.webp', 'photo.tiff', 'photo.avif']) {
      expect(isImagePath(path)).toBe(false)
    }
  })

  it('does not flag text/code files', () => {
    for (const path of ['app.js', 'README.md', 'styles.css', 'noext']) {
      expect(isImagePath(path)).toBe(false)
    }
  })

  it('does not flag SVG, which is text-based XML, not raster', () => {
    expect(isImagePath('logo.svg')).toBe(false)
  })
})

describe('imageMimeType', () => {
  it('maps supported attachment formats to data URL MIME types', () => {
    expect(imageMimeType('photo.png')).toBe('image/png')
    expect(imageMimeType('photo.JPG')).toBe('image/jpeg')
    expect(imageMimeType('anim.gif')).toBe('image/gif')
    expect(imageMimeType('scan.bmp')).toBe('image/bmp')
  })
})

describe('hasExpectedImageSignature', () => {
  it('accepts matching PNG, JPEG, GIF, and BMP signatures', () => {
    expect(
      hasExpectedImageSignature('photo.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ).toBe(true)
    expect(hasExpectedImageSignature('photo.jpg', Buffer.from([0xff, 0xd8, 0xff]))).toBe(true)
    expect(hasExpectedImageSignature('anim.gif', Buffer.from('GIF89a'))).toBe(true)
    expect(hasExpectedImageSignature('scan.bmp', Buffer.from('BM'))).toBe(true)
  })

  it('rejects an extension whose bytes are not an image', () => {
    expect(hasExpectedImageSignature('fake.png', Buffer.from('not an image'))).toBe(false)
  })
})

describe('isLikelyBinary', () => {
  it('treats a buffer with a NUL byte as binary', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a])
    expect(isLikelyBinary(buffer)).toBe(true)
  })

  it('treats plain UTF-8 text as not binary', () => {
    const buffer = Buffer.from('const x = 1;\nconsole.log(x);\n', 'utf-8')
    expect(isLikelyBinary(buffer)).toBe(false)
  })

  it('only sniffs the leading bytes, not the whole file', () => {
    const text = 'a'.repeat(20_000)
    const buffer = Buffer.concat([Buffer.from(text, 'utf-8'), Buffer.from([0x00])])
    expect(isLikelyBinary(buffer)).toBe(false)
  })
})
