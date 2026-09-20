import { describe, expect, it } from 'vitest'
import { chooseRemoteIdentity, identityOf, type StoredIdentity } from '../identityRecovery'
import { fingerprintOf, generateRemoteCertificate } from '../certificate'

/**
 * Choosing which identity to serve, having lost one to the old logic.
 *
 * A phone pins the certificate fingerprint at pairing, so the identity *is* the
 * pairing. The version of this that shipped kept a single spare and, on recovery,
 * promoted the spare and deleted it — overwriting the current identity in the same
 * move. It was never tested, which is how it survived.
 *
 * What that cost, from a real log:
 *
 * ```
 * 13:09  listening (fingerprint 62506165…)   phone attaches, works all afternoon
 * 13:42  could not decrypt the remote private key
 * 13:42  recovered the previous remote identity — earlier pairings work again
 * 13:42  listening (fingerprint dda71f38…)   phone refuses; 62506165 gone from disk
 * ```
 *
 * So these are mostly about *not losing things*. The decryptability of a key is a
 * property of the launch, not of the file, and any rule that treats an unreadable
 * key as a dead one throws away something that would have worked tomorrow.
 */
describe('chooseRemoteIdentity', () => {
  /** Two real certificates, since the choice turns on their fingerprints. */
  const identities = async (): Promise<[StoredIdentity, StoredIdentity]> => {
    const first = await generateRemoteCertificate('first')
    const second = await generateRemoteCertificate('second')
    return [
      { certPem: first.certPem, encryptedKeyPem: 'enc:first' },
      { certPem: second.certPem, encryptedKeyPem: 'enc:second' }
    ]
  }

  /** A safeStorage that can read only what this launch happens to be able to. */
  const reader =
    (...readable: string[]) =>
    (encrypted: string): string | null =>
      readable.includes(encrypted) ? `key-for-${encrypted}` : null

  it('serves the current identity when it can be read', () => {
    const current = { certPem: 'CERT', encryptedKeyPem: 'enc:current' }

    const choice = chooseRemoteIdentity({
      current,
      archived: [],
      decrypt: reader('enc:current')
    })

    expect(choice.outcome).toBe('current')
    expect(choice.serve?.certPem).toBe('CERT')
    expect(choice.current).toBe(current)
    expect(choice.breaksPairing).toBe(false)
  })

  it('never discards the identity it could not read', async () => {
    // The whole bug, as one assertion. The old code deleted this, and with it every
    // chance of a later launch putting the pairing back.
    const [live, old] = await identities()

    const choice = chooseRemoteIdentity({
      current: live,
      archived: [old],
      decrypt: reader('enc:second')
    })

    expect(choice.outcome).toBe('recovered')
    expect(choice.current).toEqual(old)
    expect(choice.archived).toContainEqual(live)
  })

  it('prefers the identity the phone actually paired with', async () => {
    // Restoring one no device has ever seen achieves nothing and costs the one that
    // was working. With the fingerprint recorded, this is decidable rather than a
    // guess.
    const [wanted, other] = await identities()

    const choice = chooseRemoteIdentity({
      current: { certPem: 'UNREADABLE', encryptedKeyPem: 'enc:current' },
      archived: [other, wanted],
      decrypt: reader('enc:first', 'enc:second'),
      pairedFingerprint: fingerprintOf(wanted.certPem)
    })

    expect(choice.serve?.certPem).toBe(wanted.certPem)
    expect(choice.breaksPairing).toBe(false)
  })

  it('says so when the identity it recovered is not the paired one', async () => {
    // The pairing is broken either way — an unreadable key cannot be served — but
    // the user needs to hear "pair again", not "earlier pairings work again".
    const [paired, other] = await identities()

    const choice = chooseRemoteIdentity({
      current: paired,
      archived: [other],
      decrypt: reader('enc:second'),
      pairedFingerprint: fingerprintOf(paired.certPem)
    })

    expect(choice.outcome).toBe('recovered')
    expect(choice.breaksPairing).toBe(true)
    // And the one the phone trusts is still on disk, so a later launch can fix it.
    expect(choice.archived).toContainEqual(paired)
  })

  it('keeps a device paired across a launch that can read everything', async () => {
    // The happy case for the fingerprint: nothing is swapped out from under a phone
    // just because more than one identity is readable.
    const [paired, other] = await identities()

    const choice = chooseRemoteIdentity({
      current: paired,
      archived: [other],
      decrypt: reader('enc:first', 'enc:second'),
      pairedFingerprint: fingerprintOf(paired.certPem)
    })

    expect(choice.outcome).toBe('current')
    expect(choice.serve?.certPem).toBe(paired.certPem)
  })

  /**
   * The state a fallback leaves behind, and the one that made the phone look
   * intermittently broken.
   *
   * Taken from a real machine: four devices all pinned `1e747be6a675fd56`,
   * which was sitting readable in the archive, while `dda71f3866996f74` was
   * current. Every launch that could read `dda7…` served it and reported the
   * pairing as fine; the phone worked again only on the launches that happened
   * to fail to decrypt it.
   */
  it('puts the paired identity back when the current one is merely readable', async () => {
    const [paired, stepped] = await identities()

    const choice = chooseRemoteIdentity({
      current: stepped,
      archived: [paired],
      decrypt: reader('enc:first', 'enc:second'),
      pairedFingerprint: fingerprintOf(paired.certPem)
    })

    expect(choice.serve?.certPem).toBe(paired.certPem)
    expect(choice.current).toBe(paired)
    expect(choice.breaksPairing).toBe(false)
    expect(choice.movedBecause).toBe('not-the-paired-one')
    // Nothing is dropped, here as everywhere else in this module.
    expect(choice.archived).toContainEqual(stepped)
    expect(choice.archived).not.toContainEqual(paired)
  })

  it('keeps serving a readable identity when the paired one cannot be read', async () => {
    // Nothing better exists on disk, so the wrong identity is still the best
    // answer — but it must not be reported as a working pairing.
    const [paired, stepped] = await identities()

    const choice = chooseRemoteIdentity({
      current: stepped,
      archived: [paired],
      decrypt: reader('enc:second'),
      pairedFingerprint: fingerprintOf(paired.certPem)
    })

    expect(choice.outcome).toBe('current')
    expect(choice.serve?.certPem).toBe(stepped.certPem)
    expect(choice.breaksPairing).toBe(true)
    expect(choice.archived).toContainEqual(paired)
  })

  it('does not go looking when no device has pinned anything', async () => {
    // Without a pinned fingerprint there is no "right" identity to prefer, and
    // swapping on a guess would break the very thing this protects.
    const [first, second] = await identities()

    const choice = chooseRemoteIdentity({
      current: second,
      archived: [first],
      decrypt: reader('enc:first', 'enc:second')
    })

    expect(choice.outcome).toBe('current')
    expect(choice.serve?.certPem).toBe(second.certPem)
    expect(choice.movedBecause).toBeUndefined()
  })

  it('survives a certificate in the archive that will not parse', async () => {
    // A corrupt entry is one identity that cannot be matched, not a reason to
    // throw on startup and leave the machine unreachable.
    const [paired, stepped] = await identities()

    const choice = chooseRemoteIdentity({
      current: stepped,
      archived: [{ certPem: 'NOT A CERTIFICATE', encryptedKeyPem: 'enc:junk' }, paired],
      decrypt: reader('enc:first', 'enc:second', 'enc:junk'),
      pairedFingerprint: fingerprintOf(paired.certPem)
    })

    expect(choice.serve?.certPem).toBe(paired.certPem)
  })

  it('falls back to any readable identity when the pairing predates the record', async () => {
    // Devices paired before `certFingerprint` existed have no answer. Guessing the
    // newest readable one is no worse than the old behaviour and still loses nothing.
    const [first, second] = await identities()

    const choice = chooseRemoteIdentity({
      current: { certPem: 'UNREADABLE', encryptedKeyPem: 'enc:current' },
      archived: [first, second],
      decrypt: reader('enc:first', 'enc:second')
    })

    expect(choice.outcome).toBe('recovered')
    expect(choice.serve?.certPem).toBe(first.certPem)
    expect(choice.archived).toHaveLength(2)
  })

  it('reports having nothing to serve rather than inventing one', () => {
    // The caller generates a fresh identity in this case. It must do that knowing
    // the old ones are still on disk, not because this pretended they were gone.
    const current = { certPem: 'CERT', encryptedKeyPem: 'enc:current' }
    const archived = [{ certPem: 'OLD', encryptedKeyPem: 'enc:old' }]

    const choice = chooseRemoteIdentity({
      current,
      archived,
      decrypt: () => null,
      pairedFingerprint: 'whatever-the-phone-pinned'
    })

    expect(choice.outcome).toBe('none')
    expect(choice.serve).toBeNull()
    expect(choice.breaksPairing).toBe(true)
    expect(choice.current).toBe(current)
    expect(choice.archived).toBe(archived)
  })

  it('has nothing to break when no device is paired', () => {
    const choice = chooseRemoteIdentity({
      current: { certPem: 'CERT', encryptedKeyPem: 'enc:current' },
      archived: [],
      decrypt: () => null
    })

    expect(choice.outcome).toBe('none')
    expect(choice.breaksPairing).toBe(false)
  })

  it('starts from nothing on a machine that has never listened', () => {
    const choice = chooseRemoteIdentity({ current: null, archived: [], decrypt: () => null })

    expect(choice.outcome).toBe('none')
    expect(choice.serve).toBeNull()
    expect(choice.current).toBeNull()
    expect(choice.breaksPairing).toBe(false)
  })

  it('does not duplicate an identity across current and archive', async () => {
    // The archive is appended to for the life of the machine, so a promotion that
    // left a copy behind would grow it without bound and make "which is current"
    // ambiguous.
    const [live, old] = await identities()

    const choice = chooseRemoteIdentity({
      current: live,
      archived: [old],
      decrypt: reader('enc:second')
    })

    expect(choice.archived).not.toContainEqual(choice.current)
    expect(choice.archived).toHaveLength(1)
  })
})

describe('identityOf', () => {
  it('is null unless both halves are present', () => {
    // Half an identity is not one: a certificate with no key cannot be served, and a
    // key with no certificate cannot be pinned.
    expect(identityOf(undefined, undefined)).toBeNull()
    expect(identityOf('CERT', undefined)).toBeNull()
    expect(identityOf(undefined, 'enc')).toBeNull()
    expect(identityOf('CERT', 'enc')).toEqual({ certPem: 'CERT', encryptedKeyPem: 'enc' })
  })
})
