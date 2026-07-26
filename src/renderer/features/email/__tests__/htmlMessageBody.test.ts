import { describe, expect, it } from 'vitest'
import { buildFrameDocument, EMAIL_FRAME_SANDBOX } from '../htmlFrameDocument'

describe('email HTML frame', () => {
  it('allows height measurement without allowing message scripts', () => {
    expect(EMAIL_FRAME_SANDBOX).toContain('allow-same-origin')
    expect(EMAIL_FRAME_SANDBOX).not.toContain('allow-scripts')
  })

  it('hands scrolling to the outer reader', () => {
    const document = buildFrameDocument('<p>Message body</p>', {
      dark: true,
      showRemote: false
    })

    expect(document).toContain('height: auto !important')
    expect(document).toContain('overflow: hidden !important')
    expect(document).toContain("script-src 'none'")
  })
})
