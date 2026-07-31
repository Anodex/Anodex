import { describe, expect, it } from 'vitest'
import {
  buildFrameDocument,
  collectRemoteImageUrls,
  EMAIL_FRAME_SANDBOX,
  inlineRemoteImages
} from '../htmlFrameDocument'

describe('email HTML frame', () => {
  it('allows height measurement without allowing message scripts', () => {
    expect(EMAIL_FRAME_SANDBOX).toContain('allow-same-origin')
    expect(EMAIL_FRAME_SANDBOX).not.toContain('allow-scripts')
  })

  it('hands scrolling to the outer reader', () => {
    const document = buildFrameDocument('<p>Message body</p>', { dark: true })

    expect(document).toContain('height: auto !important')
    expect(document).toContain('overflow: hidden !important')
    expect(document).toContain("script-src 'none'")
  })

  it('never widens img-src past data:, in either state', () => {
    // A srcdoc frame inherits the app's `img-src 'self' data:` and can only
    // tighten it, so naming https: here would be a promise the frame cannot
    // keep. Remote images arrive already inlined as data: URIs instead.
    for (const document of [
      buildFrameDocument('<img data-remote-src="https://x.test/a.png">', { dark: false }),
      buildFrameDocument('<img data-remote-src="https://x.test/a.png">', {
        dark: false,
        images: { 'https://x.test/a.png': 'data:image/png;base64,AAA' }
      })
    ]) {
      expect(document).toContain('img-src data:')
      expect(document).not.toContain('img-src data: https:')
    }
  })
})

describe('collectRemoteImageUrls', () => {
  it('finds each parked URL once', () => {
    expect(
      collectRemoteImageUrls(
        '<img data-remote-src="https://a.test/1.png"><img data-remote-src="https://b.test/2.png">' +
          '<img data-remote-src="https://a.test/1.png">'
      )
    ).toEqual(['https://a.test/1.png', 'https://b.test/2.png'])
  })

  it('decodes the entities the sanitizer escaped attributes with', () => {
    expect(collectRemoteImageUrls('<img data-remote-src="https://a.test/x?a=1&amp;b=2">')).toEqual([
      'https://a.test/x?a=1&b=2'
    ])
  })

  it('finds nothing in a message with no blocked images', () => {
    expect(collectRemoteImageUrls('<img src="data:image/png;base64,AAA">')).toEqual([])
    expect(collectRemoteImageUrls('')).toEqual([])
  })
})

describe('inlineRemoteImages', () => {
  const HTML =
    '<img data-remote-src="https://a.test/1.png"><img data-remote-src="https://b.test/2.png">'

  it('swaps a fetched image in as a real src', () => {
    const result = inlineRemoteImages(HTML, { 'https://a.test/1.png': 'data:image/png;base64,AAA' })
    expect(result).toContain('<img src="data:image/png;base64,AAA">')
  })

  it('leaves an image that could not be fetched parked, and so still hidden', () => {
    // Pointing an <img> at a URL that just failed would draw a broken glyph;
    // the CSS hides anything still carrying data-remote-src.
    const result = inlineRemoteImages(HTML, { 'https://a.test/1.png': 'data:image/png;base64,AAA' })
    expect(result).toContain('data-remote-src="https://b.test/2.png"')
  })

  it('matches on the decoded URL, since the attribute is escaped', () => {
    const html = '<img data-remote-src="https://a.test/x?a=1&amp;b=2">'
    const result = inlineRemoteImages(html, {
      'https://a.test/x?a=1&b=2': 'data:image/gif;base64,B'
    })
    expect(result).toContain('<img src="data:image/gif;base64,B">')
  })

  it('changes nothing when nothing was fetched', () => {
    expect(inlineRemoteImages(HTML, {})).toBe(HTML)
  })
})
