/**
 * Which version of the phone app this desktop build was released alongside.
 *
 * ## Why the desktop is the one that knows
 *
 * Neither end can ask GitHub. `Anodex/Anodex` is private, so checking its releases
 * from an installed app needs a credential, and a credential shipped inside a
 * distributed binary is not a secret — the app has to be able to unlock it, so
 * anyone holding the app can follow the same path. That was decided for the
 * desktop's own updater and the reasoning applies unchanged to a phone.
 *
 * So nothing calls out. The desktop simply knows what it shipped with, and tells
 * the paired phone during the handshake. The phone compares it against its own
 * build and says so if it is behind.
 *
 * That makes "up to date" mean *matched to this desktop*, which is the more useful
 * meaning anyway: the two talk over a versioned protocol, and a phone newer than
 * the computer it drives is not obviously a good thing.
 *
 * ## Keeping it honest
 *
 * This is a hand-maintained constant pointing at another repository, which is a
 * shape that rots. **Bump it in the same change that tags a mobile release.** If it
 * is stale the failure is mild and self-correcting — the phone is told it is up to
 * date when a newer build exists — but the whole feature is worthless if nobody
 * trusts it, so treat a stale value as a bug rather than a nit.
 */
export const EXPECTED_MOBILE_VERSION = '0.16.0'

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
