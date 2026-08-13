import { describe, expect, it } from 'vitest'
import { isEligibleDesktopWindow, type DesktopWindowTarget } from '../WindowsDesktopControlBackend'

function desktopWindow(overrides: Partial<DesktopWindowTarget> = {}): DesktopWindowTarget {
  return {
    handle: '42',
    processId: 101,
    processPath: 'C:\\Apps\\Example.exe',
    title: 'Example',
    bounds: { x: 400, y: 200, width: 800, height: 600 },
    ...overrides
  }
}

describe('isEligibleDesktopWindow', () => {
  it('allows an ordinary, visible application window', () => {
    expect(isEligibleDesktopWindow(desktopWindow())).toBe(true)
  })

  it.each([
    { processPath: 'C:\\Windows\\System32\\LogonUI.exe', title: 'Sign in' },
    { title: '1Password - vault' },
    { title: 'Enter your password' },
    { title: 'Checkout - Example Store' },
    { title: 'Your verification code' }
  ])('excludes protected desktop surfaces: $title', (overrides) => {
    expect(isEligibleDesktopWindow(desktopWindow(overrides))).toBe(false)
  })

  it('never exposes Anodex itself through the generic desktop backend', () => {
    expect(isEligibleDesktopWindow(desktopWindow({ processId: process.pid }))).toBe(false)
  })
})
