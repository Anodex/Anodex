import { describe, expect, it } from 'vitest'
import { looksLikeHtml, sanitizeEmailHtml, type InlineImage } from '../htmlBody'

const pixel = (contentId: string): InlineImage => ({
  contentId,
  mimeType: 'image/png',
  data: Buffer.from('89504e47', 'hex')
})

describe('sanitizeEmailHtml', () => {
  it('removes scripts along with their contents', () => {
    const output = sanitizeEmailHtml('<p>Hi</p><script>steal()</script><p>Bye</p>')

    expect(output).not.toContain('script')
    expect(output).not.toContain('steal()')
    expect(output).toContain('<p>Hi</p>')
    expect(output).toContain('<p>Bye</p>')
  })

  it('removes an unclosed script tag too', () => {
    // A paired-tag pattern alone would leave this behind.
    expect(sanitizeEmailHtml('<p>Hi</p><script src="evil.js">')).not.toContain('script')
  })

  it('strips frames, objects, and forms that could host active content', () => {
    const output = sanitizeEmailHtml(
      '<iframe src="evil"></iframe><object data="x"></object><form action="/x"><input name="pw"></form><p>Safe</p>'
    )

    expect(output).not.toMatch(/iframe|object|form|input/i)
    expect(output).toContain('<p>Safe</p>')
  })

  it('removes inline event handlers in every quoting style', () => {
    const output = sanitizeEmailHtml(
      `<div onclick="a()" onmouseover='b()' onload=c()><span>text</span></div>`
    )

    expect(output).not.toMatch(/onclick|onmouseover|onload/i)
    expect(output).toContain('<span>text</span>')
  })

  it('defuses javascript and data:text/html URLs', () => {
    const output = sanitizeEmailHtml(
      `<a href="javascript:alert(1)">x</a><a href='data:text/html,<script>1</script>'>y</a>`
    )

    expect(output).not.toContain('javascript:')
    expect(output).not.toContain('data:text/html')
  })

  it('embeds inline cid images as data URIs', () => {
    const output = sanitizeEmailHtml('<img src="cid:logo123">', [pixel('<logo123>')])

    expect(output).toContain('data:image/png;base64,')
    expect(output).not.toContain('cid:logo123')
  })

  it('matches a cid reference regardless of angle brackets or case', () => {
    // Content-ID headers are bracketed; the cid: URL form is not.
    const output = sanitizeEmailHtml('<img src="cid:LOGO123">', [pixel('<logo123>')])

    expect(output).toContain('data:image/png;base64,')
  })

  it('leaves an unmatched cid reference alone rather than corrupting it', () => {
    const output = sanitizeEmailHtml('<img src="cid:missing">', [pixel('other')])

    expect(output).toContain('cid:missing')
  })

  it('defers remote images instead of loading them', () => {
    // A remote <img> is a read receipt for the sender; it must not fire until
    // the reader asks for it.
    const output = sanitizeEmailHtml('<img src="https://tracker.example/pixel.gif" width="1">')

    expect(output).toContain('data-remote-src="https://tracker.example/pixel.gif"')
    expect(output).not.toMatch(/\ssrc=/)
    expect(output).toContain('width="1"')
  })

  it('does not defer images that are already embedded', () => {
    const output = sanitizeEmailHtml('<img src="data:image/png;base64,AAAA">')

    expect(output).toContain('src="data:image/png;base64,AAAA"')
    expect(output).not.toContain('data-remote-src')
  })

  it('forces links to open externally without leaking a referrer', () => {
    const output = sanitizeEmailHtml('<a href="https://example.com" target="_self">go</a>')

    expect(output).toContain('target="_blank"')
    expect(output).toContain('rel="noopener noreferrer"')
    expect(output).not.toContain('_self')
  })

  it('honours the inline image size budget', () => {
    const huge: InlineImage = {
      contentId: 'big',
      mimeType: 'image/png',
      data: Buffer.alloc(9 * 1024 * 1024)
    }
    const output = sanitizeEmailHtml('<img src="cid:big">', [huge])

    expect(output).toContain('cid:big')
    expect(output).not.toContain('data:image/png;base64,')
  })

  it('keeps style blocks, which most newsletters need to look right', () => {
    // CSS cannot execute, and the frame's CSP refuses the remote url() fetches
    // it could otherwise attempt — so stripping it would only cost fidelity.
    const output = sanitizeEmailHtml('<style>.a{color:red}</style><p class="a">Hi</p>')

    expect(output).toContain('<style>.a{color:red}</style>')
    expect(output).toContain('class="a"')
  })

  it('keeps ordinary formatting intact', () => {
    const output = sanitizeEmailHtml(
      '<table><tr><td><b>Bold</b> and <i>italic</i></td></tr></table>'
    )

    expect(output).toContain('<table>')
    expect(output).toContain('<b>Bold</b>')
    expect(output).toContain('<i>italic</i>')
  })
})

describe('looksLikeHtml', () => {
  it('recognizes markup and ignores plain text', () => {
    expect(looksLikeHtml('<div>hello</div>')).toBe(true)
    expect(looksLikeHtml('<p>hi</p>')).toBe(true)
    expect(looksLikeHtml('just some text with < and > signs')).toBe(false)
  })
})
