import { fingerprintOf } from './certificate'

/**
 * One identity this machine has served, as it sits on disk.
 *
 * The key is `safeStorage`-encrypted, so holding an identity is not the same as
 * being able to use one — that is the whole difficulty this module exists for.
 */
export interface StoredIdentity {
  certPem: string
  /** safeStorage-encrypted, base64. Never written in the clear. */
  encryptedKeyPem: string
}

/** A stored identity from two loose fields, or null when either is missing. */
export function identityOf(
  certPem: string | undefined,
  encryptedKeyPem: string | undefined
): StoredIdentity | null {
  if (!certPem || !encryptedKeyPem) return null
  return { certPem, encryptedKeyPem }
}

/** What to serve this launch, and what to write back. */
export interface IdentityChoice {
  /** The identity to listen with, or null when nothing on disk can be read. */
  serve: { certPem: string; privateKeyPem: string } | null
  /** What becomes `certPem`/`encryptedKeyPem` on disk. */
  current: StoredIdentity | null
  /**
   * Every other identity this machine has ever used.
   *
   * Nothing is ever dropped from here. That is the point of the module.
   */
  archived: StoredIdentity[]
  outcome: 'current' | 'recovered' | 'none'
  /**
   * True when the identity being served is not the one the paired device pinned.
   *
   * The pairing is broken this launch either way — an identity that cannot be
   * decrypted cannot be served — but saying so is the difference between a phone
   * the user re-pairs in a minute and one they spend an evening on.
   */
  breaksPairing: boolean
  /**
   * Why the identity being served is not the one that was current, when it is
   * not. Absent when `current` was served.
   *
   * The caller writes a different line for each, and they are genuinely
   * different events: `unreadable` means a launch could not decrypt a key and
   * something else had to be served, while `not-the-paired-one` means the key
   * was perfectly readable and simply belonged to the wrong identity.
   */
  movedBecause?: 'unreadable' | 'not-the-paired-one'
}

/**
 * Decide which identity to serve, without ever losing one.
 *
 * ## The bug this exists to make impossible
 *
 * A phone pins the certificate fingerprint at pairing, so the identity *is* the
 * pairing. The previous version of this logic kept one spare — `previousCertPem` —
 * and on recovery **promoted the spare and deleted it**, overwriting the current
 * identity in the same move. Observed in the wild:
 *
 * ```
 * 13:09  listening (fingerprint 62506165…)   phone attaches, works all afternoon
 * 13:42  could not decrypt the remote private key
 * 13:42  recovered the previous remote identity — earlier pairings work again
 * 13:42  listening (fingerprint dda71f38…)   phone refuses; 62506165 gone from disk
 * ```
 *
 * The phone was paired to `62506165`. Its encrypted key was still on disk and
 * perfectly good — `safeStorage` simply could not read it *that launch* — and the
 * recovery threw it away to restore an identity nothing was using. There is no
 * route back from that: a later launch that could have read it has nothing left to
 * read. The log line was also the exact inverse of what happened.
 *
 * ## The rule
 *
 * "Cannot decrypt" is usually a fact about the launch, not about the file. So an
 * unreadable identity is **archived, never discarded**, and a later launch that can
 * read it can put it back. The archive only grows, and it is small: one entry per
 * identity this machine has ever generated.
 *
 * Preference goes to an identity the paired device actually pinned, because the
 * point of recovering at all is to make a phone work again — restoring one no
 * device has ever seen achieves nothing and costs the one that was working.
 *
 * That preference applies on **every** launch, not only the ones that have to
 * recover. It used to apply only when the current identity could not be read,
 * which left a fallback permanently in place: having stepped down to a
 * non-paired identity once, every later launch read it successfully, served it,
 * and reported the pairing as fine. Measured on a real machine — four devices
 * all pinned to `1e747be6a675fd56`, sitting readable in the archive, while the
 * desktop listened as `dda71f3866996f74` and said nothing was wrong. The phone
 * worked again only on the launches that happened to fail to decrypt the wrong
 * identity, which is why it looked intermittent.
 *
 * @param decrypt returns null when the key cannot be read *this launch*. Injected
 *   so the rules can be tested without `safeStorage`, the way `PairingService`
 *   takes its store.
 * @param pairedFingerprint the fingerprint the paired device pinned, when it is
 *   known. Undefined for a device paired before it was recorded, and for no device.
 */
export function chooseRemoteIdentity({
  current,
  archived,
  decrypt,
  pairedFingerprint
}: {
  current: StoredIdentity | null
  archived: StoredIdentity[]
  decrypt: (encrypted: string) => string | null
  pairedFingerprint?: string
}): IdentityChoice {
  const readable = (identity: StoredIdentity) => decrypt(identity.encryptedKeyPem)
  /**
   * Whether this identity is the one the paired device pinned.
   *
   * Tolerant of a certificate that will not parse: a corrupt entry in the
   * archive is one identity that cannot be matched, not a reason to fail the
   * launch and leave the machine unreachable.
   */
  const matchesPairing = (identity: StoredIdentity): boolean => {
    if (pairedFingerprint === undefined) return false
    try {
      return fingerprintOf(identity.certPem) === pairedFingerprint
    } catch {
      return false
    }
  }

  // The ordinary path, and the overwhelmingly common one.
  const currentKey = current ? readable(current) : null
  if (current && currentKey && (pairedFingerprint === undefined || matchesPairing(current))) {
    return {
      serve: { certPem: current.certPem, privateKeyPem: currentKey },
      current,
      archived,
      outcome: 'current',
      breaksPairing: false
    }
  }

  // The current identity is readable but is not the one the devices pinned.
  //
  // This is the state a fallback leaves behind, and it used to be permanent. A
  // launch that could not read the paired identity recovers the next best one
  // and *promotes it to current* — correctly, since something has to be served.
  // But every later launch then took the branch above, served that identity
  // because it decrypted, and reported `breaksPairing: false` without ever
  // comparing it to the pairing. Observed on a real machine: four devices all
  // pinned to `1e747be6a675fd56`, which sat readable in the archive, while the
  // desktop listened as `dda71f3866996f74` launch after launch and said nothing
  // was wrong. The pairing only came back on the launches that happened to fail
  // to decrypt the wrong identity.
  //
  // So the preference the recovery branch already applies belongs here too: if
  // the identity the devices actually pinned can be read, put it back.
  if (current && currentKey) {
    const pairedInArchive = archived
      .map((identity) => ({ identity, privateKeyPem: readable(identity) }))
      .find(
        (candidate): candidate is { identity: StoredIdentity; privateKeyPem: string } =>
          candidate.privateKeyPem !== null && matchesPairing(candidate.identity)
      )
    if (pairedInArchive) {
      return {
        serve: {
          certPem: pairedInArchive.identity.certPem,
          privateKeyPem: pairedInArchive.privateKeyPem
        },
        current: pairedInArchive.identity,
        // The identity being stepped down keeps its place, exactly as in the
        // recovery branch: nothing is ever dropped.
        archived: [current, ...archived.filter((entry) => entry !== pairedInArchive.identity)],
        outcome: 'recovered',
        breaksPairing: false,
        movedBecause: 'not-the-paired-one'
      }
    }
    // Nothing better to serve. Serve what can be read, and say plainly that the
    // pairing is not being honoured instead of claiming it is.
    return {
      serve: { certPem: current.certPem, privateKeyPem: currentKey },
      current,
      archived,
      outcome: 'current',
      breaksPairing: true
    }
  }

  // The current identity cannot be served this launch. Whatever happens next, the
  // phone paired to it is already cut off — so the only question is whether
  // anything else on disk can be read, and the current one keeps its place in the
  // archive so a luckier launch can restore it.
  const candidates = archived
    .map((identity) => ({ identity, privateKeyPem: readable(identity) }))
    .filter(
      (candidate): candidate is { identity: StoredIdentity; privateKeyPem: string } =>
        candidate.privateKeyPem !== null
    )

  // The one the phone is actually paired to, if it is among them.
  const preferred =
    candidates.find((candidate) => matchesPairing(candidate.identity)) ?? candidates[0]

  if (!preferred) {
    return {
      serve: null,
      current,
      archived,
      outcome: 'none',
      // Nothing can be served, so nothing can be claimed about the pairing beyond
      // the fact that this launch cannot honour it.
      breaksPairing: pairedFingerprint !== undefined
    }
  }

  const rest = archived.filter((identity) => identity !== preferred.identity)
  if (current) rest.unshift(current)

  return {
    serve: { certPem: preferred.identity.certPem, privateKeyPem: preferred.privateKeyPem },
    current: preferred.identity,
    archived: rest,
    outcome: 'recovered',
    breaksPairing: !matchesPairing(preferred.identity) && pairedFingerprint !== undefined,
    movedBecause: 'unreadable'
  }
}
