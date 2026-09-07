/**
 * Which version of the phone app this desktop build was released alongside.
 *
 * ## Why the desktop is the one that knows
 *
 * Originally because nothing could ask GitHub: both repositories were private, and
 * a credential shipped inside a distributed binary is not a secret. Both are public
 * now, and the phone does read its own releases directly — see `update/Releases.kt`
 * over there. So this is no longer the only signal, and it is worth being clear
 * about what it is still for.
 *
 * It answers a different question. GitHub knows what *exists*; this knows what *this
 * computer was tested against*, which is what "up to date" ought to mean between two
 * halves of one product talking over a versioned protocol — a phone running ahead of
 * the machine it drives is not obviously a good thing.
 *
 * It is also the only one that works when the phone can reach the desktop and not
 * much else, which is a real case rather than a hypothetical: a LAN with the phone's
 * mobile data off.
 *
 * ## Keeping it honest
 *
 * This is a hand-maintained constant pointing at another repository, which is a
 * shape that rots. **Bump it in the same change that tags a mobile release.** If it
 * is stale the failure is mild and self-correcting — the phone is told it is up to
 * date when a newer build exists — but the whole feature is worthless if nobody
 * trusts it, so treat a stale value as a bug rather than a nit.
 */
export const EXPECTED_MOBILE_VERSION = '0.30.0'

/**
 * Whether `candidate` is older than `reference`, by dotted numeric parts.
 *
 * Deliberately not a semver library. These versions are ours, they are always
 * `major.minor.patch`, and a dependency whose job is to compare three integers is a
 * dependency to explain rather than one to add.
 *
 * Anything unparseable compares as *not older*. A phone that reports a version this
 * cannot read gets left alone rather than being nagged to update to something it
 * may already have — failing quiet is right for a notice nobody asked for.
 */
export function isOlderVersion(candidate: string, reference: string): boolean {
  const left = parseVersion(candidate)
  const right = parseVersion(reference)
  if (!left || !right) return false

  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index]
  }
  return false
}

function parseVersion(value: string): [number, number, number] | null {
  // A trailing `-preview.3` and friends are ignored rather than rejected: the
  // numeric part is what orders these, and the suffix is a label.
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+].*)?$/.exec(value.trim())
  if (!match) return null

  return [Number(match[1]), Number(match[2]), Number(match[3])]
}
