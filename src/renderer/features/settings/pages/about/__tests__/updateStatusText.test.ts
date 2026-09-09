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

  it('describes up to date', () => {
    expect(updateStatusText({ state: 'not-available' })).toBe("You're on the latest version.")
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
