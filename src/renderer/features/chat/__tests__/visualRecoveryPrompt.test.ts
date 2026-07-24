import { describe, expect, it } from 'vitest'
import { visualRecoveryPrompt } from '../visualRecoveryPrompt'

describe('visualRecoveryPrompt', () => {
  it('requests a fresh inspection for an unavailable inspection preview', () => {
    expect(
      visualRecoveryPrompt({
        kind: 'image',
        source: 'inspection',
        title: 'Rendered page.html',
        path: 'page.html',
        mimeType: 'image/png'
      })
    ).toBe('Re-inspect "page.html" using inspect_visual and show me the new screenshot.')
  })

  it('requests display-only recovery for an assistant-shown image', () => {
    expect(
      visualRecoveryPrompt({
        kind: 'image',
        source: 'assistant',
        title: 'result.png',
        path: 'result.png',
        mimeType: 'image/png'
      })
    ).toBe('Show the workspace image at "result.png" again using show_image.')
  })
})
