import { describe, expect, it } from 'vitest'
import { updateStatusText } from '../updateStatusText'

describe('updateStatusText', () => {
  it('describes idle', () => {
    expect(updateStatusText({ state: 'idle' })).toBe('Not checked yet.')
  })

  it('describes checking', () => {
    expect(updateStatusText({ state: 'checking' })).toBe('Checking for updates…')
  })

  it('describes an available update', () => {
    expect(updateStatusText({ state: 'available', version: '0.2.0' })).toBe(
      'Version 0.2.0 is available.'
    )
  })

  it('describes up to date, and when that was established', () => {
    // The timestamp is the feature. GitHub serves the update feed through a
    // CDN, so a check made minutes after a release is answered from a cache
    // naming the previous one — and the app relays that, correctly and
    // uselessly. "Checked 2 hours ago" is a fact somebody can act on; the
    // sentence without it is one they can only believe.
    const now = 1_700_000_000_000
    expect(updateStatusText({ state: 'not-available', checkedAt: now }, now)).toBe(
      "You're on the latest version, checked just now."
    )
    expect(updateStatusText({ state: 'not-available', checkedAt: now - 240_000 }, now)).toBe(
      "You're on the latest version, checked 4 minutes ago."
    )
    expect(updateStatusText({ state: 'not-available', checkedAt: now - 7_200_000 }, now)).toBe(
      "You're on the latest version, checked 2 hours ago."
    )
  })

  it('describes download progress', () => {
    expect(updateStatusText({ state: 'downloading', version: '0.2.1', percent: 42 })).toBe(
      'Downloading update… 42%'
    )
  })

  it('describes a downloaded update ready to install', () => {
    expect(updateStatusText({ state: 'downloaded', version: '0.2.0' })).toBe(
      'Version 0.2.0 downloaded — restart to install.'
    )
  })

  it('describes the signature check in progress', () => {
    expect(updateStatusText({ state: 'verifying', version: '0.2.1' })).toBe(
      'Checking that version 0.2.1 is genuine…'
    )
  })

  it('describes a refused update', () => {
    expect(
      updateStatusText({
        state: 'rejected',
        version: '0.2.1',
        reason: 'this release carries no signature'
      })
    ).toBe('Version 0.2.1 was not installed: this release carries no signature.')
  })

  it('describes an error', () => {
    expect(updateStatusText({ state: 'error', message: 'network down' })).toBe(
      "Couldn't check for updates: network down"
    )
  })
})
