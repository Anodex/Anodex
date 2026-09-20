import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The switch itself, now that it is a setting rather than an environment
 * variable.
 *
 * This moved for a reason worth keeping in view: while voice was a latency test
 * there was nothing a person could do with a switch, so it was a variable a
 * developer set. A reply can now be read aloud, so it is a decision a person
 * makes — and the environment variable stays only as an override, because a
 * test needs to set the answer without a settings file.
 *
 * The case that matters most here is the last one. `voiceEnabled()` is called
 * during the remote handshake, which can happen before settings are readable,
 * and a throw there would take out pairing rather than voice.
 */

const settings = vi.fn<() => unknown>()

vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: {
    get: () => settings()
  }
}))

const { voiceEnabled } = await import('../voiceCapability')

beforeEach(() => {
  delete process.env.ANODEX_VOICE
  settings.mockReturnValue({ voice: { enabled: false } })
})

afterEach(() => {
  delete process.env.ANODEX_VOICE
})

describe('whether Arc may speak', () => {
  it('is off until somebody turns it on', () => {
    expect(voiceEnabled()).toBe(false)
  })

  it('follows the setting', () => {
    settings.mockReturnValue({ voice: { enabled: true } })
    expect(voiceEnabled()).toBe(true)
  })

  it('is off for a settings file written before voice existed', () => {
    // Every upgrade from a version without this key. Absent must read as off,
    // not as undefined-is-falsy-by-luck.
    settings.mockReturnValue({})
    expect(voiceEnabled()).toBe(false)
  })

  it('can be forced on and off from the environment, over the setting', () => {
    settings.mockReturnValue({ voice: { enabled: false } })
    process.env.ANODEX_VOICE = '1'
    expect(voiceEnabled()).toBe(true)

    settings.mockReturnValue({ voice: { enabled: true } })
    process.env.ANODEX_VOICE = '0'
    expect(voiceEnabled()).toBe(false)
  })

  it('says no, rather than throwing, when settings cannot be read yet', () => {
    // Called during the remote handshake, which can run before the store is
    // initialised. A throw here would break pairing to report that voice is
    // unavailable — the failure landing on the wrong feature entirely.
    settings.mockImplementation(() => {
      throw new Error('not initialised')
    })
    expect(voiceEnabled()).toBe(false)
  })
})
