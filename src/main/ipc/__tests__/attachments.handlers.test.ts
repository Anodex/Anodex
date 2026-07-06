import { describe, expect, it } from 'vitest'
import { isImagePath, isLikelyBinary } from '../attachments.handlers'

describe('isImagePath', () => {
  it('recognizes common raster image extensions', () => {
    for (const path of ['photo.png', 'photo.JPG', 'a/b/icon.ico', 'shot.webp', 'anim.gif']) {
      expect(isImagePath(path)).toBe(true)
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
