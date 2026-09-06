import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The pairing and authentication rules for a remote client.
 *
 * Deliberately free of sockets, TLS and Electron so that every decision here is
 * reachable from a unit test. This file decides *who is allowed to talk to this
 * machine*; the transport only decides how bytes get there. Anodex writes files,
 * runs commands and ships a terminal that is deliberately not sandboxed, so a
 * mistake in this file is remote code execution on the user's PC — which is the
 * reason it is small, explicit, and tested rather than convenient.
 *
 * See `docs/HANDOFF_REMOTE_MOBILE.md` §7.
 */

/** One paired phone at a time (§7.2). Pairing a new one revokes the old. */
export interface PairedDevice {
  /** Opaque id for this device, safe to log. */
  readonly deviceId: string
  /** SHA-256 of the device key. The key itself is never stored. */
  readonly keyHash: string
  /** Display name the phone offered at pairing, for the Settings list. */
  readonly name: string
  readonly pairedAtEpochMs: number
  lastSeenEpochMs: number
}

/** Persistence, injected so the rules can be tested without touching disk. */
export interface PairedDeviceStore {
  read(): PairedDevice | null
  write(device: PairedDevice | null): void
}

export interface PairingSession {
  /** The one-time secret, base64url. Carried in the QR and never reused. */
  readonly secret: string

  /**
   * A short code for the same session, for when the camera cannot be used.
   *
   * Deliberately low-entropy — about 40 bits — because it has to be readable off
   * one screen and typed into another. That is safe *here* and would not be
   * elsewhere: the session lives two minutes and dies after five wrong guesses,
   * so an attacker gets five tries at a 40-bit space inside a two-minute window
   * they cannot extend. Entropy is not the only way to make guessing hopeless.
   *
   * Redeems the same session as [secret], and burns it identically.
   */
  readonly shortCode: string

  readonly expiresAtEpochMs: number
}

export type PairingFailure =
  | { reason: 'no-session'; message: string }
  | { reason: 'expired'; message: string }
  | { reason: 'bad-secret'; message: string }
  | { reason: 'rate-limited'; message: string; retryAfterMs: number }

export type PairingOutcome =
  { ok: true; deviceKey: string; device: PairedDevice } | { ok: false; failure: PairingFailure }

/**
 * How long a pairing code is good for.
 *
 * Short because it is displayed on screen and its whole job is to be used within
 * seconds of being shown. A code that lives for an hour is an hour-long window in
 * which a photograph of the user's screen is a working credential.
 */
export const PAIRING_WINDOW_MS = 2 * 60 * 1000

/**
 * Failed attempts tolerated before pairing locks out.
 *
 * The secret is 256 bits, so this is not what stops a brute force — arithmetic
 * already does. It stops the *other* thing: an attacker on the LAN hammering the
 * endpoint, which without a cap is free, silent and unbounded.
 */
export const MAX_PAIRING_ATTEMPTS = 5
export const PAIRING_LOCKOUT_MS = 60 * 1000

export const MAX_AUTH_ATTEMPTS = 10
export const AUTH_LOCKOUT_MS = 5 * 60 * 1000

/** Bytes of entropy in a pairing secret and in a device key. */
const SECRET_BYTES = 32

/**
 * Alphabet for the typed code: Crockford base32, which drops I, L, O and U.
 *
 * Those four are what turn a typed code into a support problem — I against 1, O
 * against 0, and U because it is the one letter that shows up in words nobody
 * wants printed on their screen. Input is normalised on the way in, so a user who
 * types "l" for "1" still pairs.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 8

export class PairingService {
  private session: PairingSession | null = null
  private pairingAttempts = 0
  private pairingLockedUntil = 0
  private authAttempts = 0
  private authLockedUntil = 0

  constructor(
    private readonly store: PairedDeviceStore,
    private readonly now: () => number = Date.now
  ) {}

  /** The paired device, if any. */
  paired(): PairedDevice | null {
    return this.store.read()
  }

  /**
   * Open a pairing window and return the secret for the QR.
   *
   * Replaces any window already open, so showing the QR twice never leaves two
   * live secrets — the displayed one is always the only one that works.
   */
  beginPairing(): PairingSession {
    const session: PairingSession = {
      secret: randomBytes(SECRET_BYTES).toString('base64url'),
      shortCode: generateShortCode(),
      expiresAtEpochMs: this.now() + PAIRING_WINDOW_MS
    }
    this.session = session
    this.pairingAttempts = 0
    return session
  }

  /** Close the pairing window without pairing. Called when the QR is dismissed. */
  cancelPairing(): void {
    this.session = null
  }

  /**
   * Redeem a pairing secret for a long-lived device key.
   *
   * The secret is single-use whatever happens: consumed on success, and on
   * failure the attempt is counted. A code that survives a wrong guess is a code
   * an attacker can keep guessing at.
   */
  completePairing(offeredSecret: string, deviceName: string): PairingOutcome {
    const now = this.now()

    if (now < this.pairingLockedUntil) {
      return {
        ok: false,
        failure: {
          reason: 'rate-limited',
          message: 'Too many failed pairing attempts. Try again shortly.',
          retryAfterMs: this.pairingLockedUntil - now
        }
      }
    }

    const session = this.session
    if (!session) {
      return {
        ok: false,
        failure: {
          reason: 'no-session',
          message: 'This computer is not showing a pairing code right now.'
        }
      }
    }

    if (now >= session.expiresAtEpochMs) {
      this.session = null
      return {
        ok: false,
        failure: { reason: 'expired', message: 'That pairing code has expired. Show a new one.' }
      }
    }

    // Either credential redeems the session: the QR's secret, or the short code
    // typed by hand. Both are compared in constant time, and a wrong guess at
    // either counts against the same attempt budget — otherwise the short code
    // would hand an attacker a second, fresh set of tries.
    const matchesSecret = constantTimeEquals(offeredSecret, session.secret)
    const matchesCode = constantTimeEquals(normalizeShortCode(offeredSecret), session.shortCode)

    if (!matchesSecret && !matchesCode) {
      this.registerPairingFailure(now)
      return {
        ok: false,
        failure: { reason: 'bad-secret', message: 'That pairing code is not valid.' }
      }
    }

    // Success. Burn the session before issuing anything, so no path can redeem twice.
    this.session = null
    this.pairingAttempts = 0

    const deviceKey = randomBytes(SECRET_BYTES).toString('base64url')
    const device: PairedDevice = {
      deviceId: randomBytes(8).toString('hex'),
      keyHash: hashKey(deviceKey),
      name: sanitizeDeviceName(deviceName),
      pairedAtEpochMs: now,
      lastSeenEpochMs: now
    }

    // Overwrites any existing device: pairing a new phone revokes the old one (§7.2).
    this.store.write(device)
    this.authAttempts = 0
    this.authLockedUntil = 0

    return { ok: true, deviceKey, device }
  }

  /**
   * Authenticate a reconnecting client.
   *
   * Only the key's hash is stored, so a copy of the settings file is not a
   * credential. The comparison is constant-time: a length- or content-dependent
   * one leaks the stored value a byte at a time to anyone who can measure it.
   */
  authenticate(
    offeredKey: string
  ): { ok: true; device: PairedDevice } | { ok: false; failure: PairingFailure } {
    const now = this.now()

    if (now < this.authLockedUntil) {
      return {
        ok: false,
        failure: {
          reason: 'rate-limited',
          message: 'Too many failed attempts.',
          retryAfterMs: this.authLockedUntil - now
        }
      }
    }

    const device = this.store.read()
    if (!device) {
      return {
        ok: false,
        failure: { reason: 'no-session', message: 'No phone is paired with this computer.' }
      }
    }

    if (!constantTimeEquals(hashKey(offeredKey), device.keyHash)) {
      this.authAttempts += 1
      if (this.authAttempts >= MAX_AUTH_ATTEMPTS) {
        this.authLockedUntil = now + AUTH_LOCKOUT_MS
        this.authAttempts = 0
      }
      return { ok: false, failure: { reason: 'bad-secret', message: 'That device is not paired.' } }
    }

    this.authAttempts = 0
    const seen: PairedDevice = { ...device, lastSeenEpochMs: now }
    this.store.write(seen)
    return { ok: true, device: seen }
  }

  /** Forget the paired device. The phone's stored key becomes useless immediately. */
  revoke(): void {
    this.store.write(null)
    this.session = null
    this.authAttempts = 0
    this.authLockedUntil = 0
  }

  private registerPairingFailure(now: number): void {
    this.pairingAttempts += 1
    if (this.pairingAttempts >= MAX_PAIRING_ATTEMPTS) {
      this.pairingLockedUntil = now + PAIRING_LOCKOUT_MS
      this.pairingAttempts = 0
      // The window closes too: an attacker who has burned five guesses should be
      // made to wait *and* need the user to show a fresh code.
      this.session = null
    }
  }
}

function generateShortCode(): string {
  const bytes = randomBytes(CODE_LENGTH)
  let code = ''
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length]
  return code
}

/**
 * Fold a typed code into its canonical form.
 *
 * Users type what they see, which means lowercase, the separating dash, and the
 * characters the alphabet deliberately excludes. Refusing those would be blaming
 * the user for a legibility problem the code's own design created.
 */
export function normalizeShortCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V')
}

function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/**
 * Compare two secrets without leaking where they differ.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a length
 * oracle, so both sides are hashed to a fixed width first. Comparing the hashes
 * is equivalent for equality and constant-width by construction.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest()
  const right = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(left, right)
}

/**
 * A device name is attacker-supplied text rendered in desktop Settings.
 *
 * Control characters are stripped rather than escaped, and the length is capped,
 * for the same reason the phone sanitises the machine name coming the other way:
 * a name is a name, and one containing newlines is trying to reshape the UI
 * around it rather than to be read.
 */
function sanitizeDeviceName(raw: string): string {
  const cleaned = [...raw]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      const isControl = code < 0x20 || code === 0x7f
      const isBidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
      return !isControl && !isBidi
    })
    .join('')
    .trim()
    .slice(0, 64)

  return cleaned.length > 0 ? cleaned : 'Phone'
}
