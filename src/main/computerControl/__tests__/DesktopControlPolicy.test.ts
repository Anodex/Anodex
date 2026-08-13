import { describe, expect, it } from 'vitest'
import { desktopControlEligibility } from '../DesktopControlPolicy'

describe('desktopControlEligibility', () => {
  it('keeps desktop control off unless explicitly enabled', () => {
    const result = desktopControlEligibility({ desktopControlEnabled: false }, 'win32')
    expect(result.available).toBe(false)
    expect(result.reason).toContain('disabled')
  })

  it('does not expose desktop input merely because a user enabled the setting', () => {
    const result = desktopControlEligibility({ desktopControlEnabled: true }, 'win32')
    expect(result.available).toBe(false)
    expect(result.reason).toContain('packaged Windows input backend')
  })
})
