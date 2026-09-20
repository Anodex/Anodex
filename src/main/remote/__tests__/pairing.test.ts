import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_AUTH_ATTEMPTS,
  MAX_PAIRED_DEVICES,
  MAX_PAIRING_ATTEMPTS,
  PAIRING_WINDOW_MS,
  PairingService,
  normalizeShortCode,
  type PairedDevice,
  type PairedDeviceStore
} from '../pairing'

/**
 * The rules that decide who may talk to this machine.
 *
 * Anodex writes files, runs commands and ships a terminal that is deliberately not
 * sandboxed, so the failure mode here is remote code execution on the user's PC.
 * Every test below is a way that could happen, not a coverage exercise.
 */
describe('remote pairing', () => {
  let stored: PairedDevice[]
  let clock: number
  let service: PairingService

  const store: PairedDeviceStore = {
    read: () => stored,
    write: (devices) => {
      stored = devices
    }
  }

  beforeEach(() => {
    stored = []
    clock = 1_757_000_000_000
    service = new PairingService(store, () => clock)
  })

  const pair = (name = 'Pixel'): string => {
    const session = service.beginPairing()
    const outcome = service.completePairing(session.secret, name)
    if (!outcome.ok) throw new Error(`expected pairing to succeed: ${outcome.failure.reason}`)
    return outcome.deviceKey
  }

  it('pairs with the displayed code and issues a device key', () => {
    const session = service.beginPairing()
    const outcome = service.completePairing(session.secret, 'Pixel')

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.deviceKey).toHaveLength(43) // 32 bytes, base64url, unpadded
    expect(service.paired()[0]?.name).toBe('Pixel')
  })

  it('never stores the device key itself', () => {
    // A copy of the settings file must not be a working credential.
    const key = pair()

    expect(stored).not.toBeNull()
    expect(JSON.stringify(stored)).not.toContain(key)
  })

  it('refuses a pairing code that was never issued', () => {
    const outcome = service.completePairing('made-up', 'Attacker')

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.reason).toBe('no-session')
    expect(service.paired()).toEqual([])
  })

  it('burns the code on success so it cannot be redeemed twice', () => {
    // Someone who photographs the screen mid-pairing must not be able to replay it.
    const session = service.beginPairing()
    expect(service.completePairing(session.secret, 'Phone').ok).toBe(true)

    const replay = service.completePairing(session.secret, 'Attacker')
    expect(replay.ok).toBe(false)
    if (replay.ok) return
    expect(replay.failure.reason).toBe('no-session')
  })

  it('expires a code that was shown and left on screen', () => {
    const session = service.beginPairing()
    clock += PAIRING_WINDOW_MS

    const outcome = service.completePairing(session.secret, 'Late')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.reason).toBe('expired')
  })

  /**
   * The number itself, because it is a security decision rather than a tuning
   * knob: while a code is live, a photograph of the screen is a working
   * credential. Three minutes is what the manual path needs — typing address,
   * port and code on a phone keyboard and then checking a ten-group
   * fingerprint overran two — and the assertion is here so raising it further
   * has to be a deliberate act rather than a convenience.
   */
  it('stays a short window, long enough to type by hand', () => {
    expect(PAIRING_WINDOW_MS).toBe(3 * 60 * 1000)
    expect(PAIRING_WINDOW_MS).toBeLessThanOrEqual(5 * 60 * 1000)
  })

  it('accepts a code used just before it lapses', () => {
    const session = service.beginPairing()
    clock += PAIRING_WINDOW_MS - 1

    expect(service.completePairing(session.secret, 'Just in time').ok).toBe(true)
  })

  it('showing a new code invalidates the previous one', () => {
    const first = service.beginPairing()
    service.beginPairing()

    const outcome = service.completePairing(first.secret, 'Stale')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.reason).toBe('bad-secret')
  })

  it('locks out after repeated wrong codes, and closes the window', () => {
    // 256 bits of entropy is what stops a brute force; this stops an attacker on the
    // LAN hammering the endpoint for free.
    const session = service.beginPairing()
    for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i++) {
      expect(service.completePairing('wrong', 'Attacker').ok).toBe(false)
    }

    const afterLockout = service.completePairing(session.secret, 'Attacker')
    expect(afterLockout.ok).toBe(false)
    if (afterLockout.ok) return
    expect(afterLockout.failure.reason).toBe('rate-limited')

    // The user has to show a fresh code afterwards, not just wait it out.
    clock += 60 * 1000
    const stillGone = service.completePairing(session.secret, 'Attacker')
    expect(stillGone.ok).toBe(false)
    if (stillGone.ok) return
    expect(stillGone.failure.reason).toBe('no-session')
  })

  it('pairing a second device keeps the first one working', () => {
    // It used to revoke the first. Setting up a test phone locked the user's own
    // phone out, and nothing on either screen said why.
    const firstKey = pair('Phone')
    const secondKey = pair('Test phone')

    expect(
      service
        .paired()
        .map((device) => device.name)
        .sort()
    ).toEqual(['Phone', 'Test phone'])
    expect(service.authenticate(firstKey).ok).toBe(true)
    expect(service.authenticate(secondKey).ok).toBe(true)
  })

  it('each device is recognised by its own key, and records only its own visit', () => {
    const firstKey = pair('Phone')
    pair('Tablet')
    clock += 60_000

    const result = service.authenticate(firstKey)

    expect(result.ok && result.device.name).toBe('Phone')
    const seen = Object.fromEntries(service.paired().map((d) => [d.name, d.lastSeenEpochMs]))
    expect(seen.Phone).toBe(clock)
    expect(seen.Tablet).toBe(clock - 60_000)
  })

  it('unpairing one device leaves the others paired', () => {
    const phoneKey = pair('Phone')
    const tabletKey = pair('Tablet')
    const tablet = service.paired().find((device) => device.name === 'Tablet')!

    service.revoke(tablet.deviceId)

    expect(service.authenticate(tabletKey).ok).toBe(false)
    expect(service.authenticate(phoneKey).ok).toBe(true)
    expect(service.paired().map((device) => device.name)).toEqual(['Phone'])
  })

  it('renames one device, cleaned like a name from pairing, and nothing else', () => {
    pair('Phone')
    pair('Tablet')
    const tablet = service.paired().find((device) => device.name === 'Tablet')!

    expect(service.rename(tablet.deviceId, '  Kitchen	tablet  ')).toBe(true)
    expect(service.rename('no-such-device', 'x')).toBe(false)

    expect(
      service
        .paired()
        .map((device) => device.name)
        .sort()
    ).toEqual(['Kitchentablet', 'Phone'])
  })

  it('past the limit, the device seen least recently is forgotten', () => {
    const keys: string[] = []
    for (let i = 0; i < MAX_PAIRED_DEVICES; i++) {
      keys.push(pair(`Device ${i}`))
      clock += 1_000
    }
    // Device 0 is the stalest; touch it so Device 1 becomes the one to go.
    expect(service.authenticate(keys[0]).ok).toBe(true)
    clock += 1_000

    pair('One more')

    expect(service.paired()).toHaveLength(MAX_PAIRED_DEVICES)
    expect(service.authenticate(keys[1]).ok).toBe(false)
    expect(service.authenticate(keys[0]).ok).toBe(true)
  })

  it('authenticates a reconnecting phone and records when it was seen', () => {
    const key = pair()
    clock += 30_000

    const result = service.authenticate(key)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.device.lastSeenEpochMs).toBe(clock)
  })

  it('refuses authentication when nothing is paired', () => {
    const result = service.authenticate('anything')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.reason).toBe('no-session')
  })

  it('locks out repeated bad device keys', () => {
    pair()
    for (let i = 0; i < MAX_AUTH_ATTEMPTS; i++) {
      expect(service.authenticate('wrong-key').ok).toBe(false)
    }

    const locked = service.authenticate('wrong-key')
    expect(locked.ok).toBe(false)
    if (locked.ok) return
    expect(locked.failure.reason).toBe('rate-limited')
  })

  it('a paired phone still connects while another device is locked out', () => {
    // Seen with two phones: one was unpaired, kept retrying its dead key, and
    // tripped the lockout for the one still paired.
    const key = pair()
    for (let i = 0; i < MAX_AUTH_ATTEMPTS; i++) service.authenticate('unpaired-phone-key')
    const locked = service.authenticate('unpaired-phone-key')
    expect(!locked.ok && locked.failure.reason).toBe('rate-limited')

    expect(service.authenticate(key).ok).toBe(true)
  })

  it('a valid key still works after someone else has been guessing', () => {
    // The lockout must not become a way to lock the real user out permanently.
    const key = pair()
    for (let i = 0; i < MAX_AUTH_ATTEMPTS - 1; i++) service.authenticate('wrong-key')

    expect(service.authenticate(key).ok).toBe(true)
    // A success clears the count, so the next wrong guess starts from zero.
    expect(service.authenticate('wrong-key').ok).toBe(false)
    expect(service.authenticate(key).ok).toBe(true)
  })

  it('revoking makes the phone key immediately useless', () => {
    const key = pair()
    expect(service.authenticate(key).ok).toBe(true)

    service.revoke()

    expect(service.paired()).toEqual([])
    expect(service.authenticate(key).ok).toBe(false)
  })

  it('sanitises the device name shown in Settings', () => {
    // Attacker-supplied text rendered in the desktop UI.
    const session = service.beginPairing()
    service.completePairing(session.secret, 'Pixel\n\rFAKE‮DEVICE ')

    expect(service.paired()[0]?.name).toBe('PixelFAKEDEVICE')
  })

  it('falls back to a name rather than rendering an empty row', () => {
    const session = service.beginPairing()
    service.completePairing(session.secret, ' ')

    expect(service.paired()[0]?.name).toBe('Phone')
  })

  it('pairs with the typed short code as well as the QR secret', () => {
    // The camera cannot always see the screen. A phone with no usable camera must
    // not be a dead end.
    const session = service.beginPairing()
    const outcome = service.completePairing(session.shortCode, 'Typed in')

    expect(outcome.ok).toBe(true)
    expect(service.paired()[0]?.name).toBe('Typed in')
  })

  it('accepts a short code the way a person actually types it', () => {
    // Lowercase, with the dash people insert, and with the characters the alphabet
    // deliberately excludes because they are unreadable. Refusing these would blame
    // the user for a legibility problem the code's own design created.
    const session = service.beginPairing()
    const typed = session.shortCode.toLowerCase().replace(/^(.{4})/, '$1-')

    expect(service.completePairing(typed, 'Phone').ok).toBe(true)
  })

  it('reads I and L as 1, and O as 0', () => {
    expect(normalizeShortCode('il0o')).toBe('1100')
    expect(normalizeShortCode('u')).toBe('V')
    expect(normalizeShortCode(' ab-cd ')).toBe('ABCD')
  })

  it('the short code excludes the characters that cause typos', () => {
    // I/1, O/0, and U. Their absence is the whole reason the code is typable.
    for (let i = 0; i < 200; i++) {
      expect(service.beginPairing().shortCode).not.toMatch(/[ILOU]/)
    }
  })

  it('burns the short code when the QR secret is used, and the reverse', () => {
    // One session, two ways in. Redeeming either must close both, or the code left
    // on screen stays live after the phone has already paired.
    const first = service.beginPairing()
    expect(service.completePairing(first.secret, 'Scanned').ok).toBe(true)
    expect(service.completePairing(first.shortCode, 'Attacker').ok).toBe(false)

    const second = service.beginPairing()
    expect(service.completePairing(second.shortCode, 'Typed').ok).toBe(true)
    expect(service.completePairing(second.secret, 'Attacker').ok).toBe(false)
  })

  it('a wrong short code spends the same attempt budget as a wrong secret', () => {
    // Otherwise the short code hands an attacker a second, fresh set of guesses at
    // the very session the first set was meant to protect.
    const session = service.beginPairing()
    for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i++) {
      expect(service.completePairing('WRONGCODE', 'Attacker').ok).toBe(false)
    }

    const outcome = service.completePairing(session.shortCode, 'Attacker')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure.reason).toBe('rate-limited')
  })

  it('issues a different short code every time', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(service.beginPairing().shortCode)

    expect(seen.size).toBe(200)
  })

  it('issues a different secret every time', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) seen.add(service.beginPairing().secret)

    expect(seen.size).toBe(50)
  })
})
