import { describe, expect, it } from 'vitest'
import { imageDownloadName } from '../imageActions'

describe('imageDownloadName', () => {
  it('uses the image MIME type instead of a rendered source extension', () => {
    expect(imageDownloadName('Rendered page.html', 'data:image/png;base64,cGl4ZWxz')).toBe(
      'Rendered page.png'
    )
  })

  it('sanitizes unsafe filename characters', () => {
    expect(imageDownloadName('before/after: view', 'data:image/jpeg;base64,cGl4ZWxz')).toBe(
      'before-after- view.jpg'
    )
  })

  it('falls back to a useful image name', () => {
    expect(imageDownloadName('', 'data:image/gif;base64,cGl4ZWxz')).toBe('image.gif')
  })
})
