import { describe, expect, it } from 'vitest'
import { imageMimeType } from '../workspace.handlers'

describe('imageMimeType', () => {
  it('returns the correct MIME type for common image extensions', () => {
    expect(imageMimeType('photo.png')).toBe('image/png')
    expect(imageMimeType('photo.jpg')).toBe('image/jpeg')
    expect(imageMimeType('photo.jpeg')).toBe('image/jpeg')
    expect(imageMimeType('photo.JPG')).toBe('image/jpeg')
    expect(imageMimeType('anim.gif')).toBe('image/gif')
    expect(imageMimeType('icon.ico')).toBe('image/x-icon')
    expect(imageMimeType('shot.webp')).toBe('image/webp')
    expect(imageMimeType('image.bmp')).toBe('image/bmp')
    expect(imageMimeType('logo.svg')).toBe('image/svg+xml')
    expect(imageMimeType('photo.tiff')).toBe('image/tiff')
    expect(imageMimeType('photo.avif')).toBe('image/avif')
  })

  it('returns octet-stream for non-image extensions', () => {
    expect(imageMimeType('file.txt')).toBe('application/octet-stream')
    expect(imageMimeType('script.js')).toBe('application/octet-stream')
    expect(imageMimeType('.htaccess')).toBe('application/octet-stream')
    expect(imageMimeType('noext')).toBe('application/octet-stream')
  })

  it('ignores path components and only looks at the final extension', () => {
    expect(imageMimeType('a/b/c/d/photo.png')).toBe('image/png')
    expect(imageMimeType('C:\\Users\\test\\image.jpg')).toBe('image/jpeg')
  })

  it('handles paths with multiple dots correctly', () => {
    expect(imageMimeType('backup.image.png')).toBe('image/png')
    expect(imageMimeType('test.file.txt')).toBe('application/octet-stream')
  })
})
