/**
 * The public half of the Anodex release-signing key.
 *
 * This is the anchor for update trust. `latest.yml` carries a sha512 for each
 * installer, but that hash arrives from the same GitHub release as the
 * installer itself — it proves the download was not corrupted in transit and
 * nothing more. Anyone able to write to a release can replace both halves and
 * every install will accept the result. The signature checked against this key
 * is what makes that substitution fail: the key's private half never goes near
 * the repository, so a release asset cannot be forged by having write access to
 * the repository.
 *
 * Baking it into the source is deliberate. It ships inside the installed app,
 * so an attacker who reaches the release cannot also reach the key that judges
 * it — the trust is pinned at install time, the way the phone pairing pins its
 * trust to the desktop that issued it.
 *
 * `null` means this build was compiled before a key was provisioned. Signature
 * checking is then inert and updates behave exactly as they did before, which
 * is the honest fallback: it does not pretend to a guarantee it cannot make.
 * Run `npm run release:keygen`, paste the printed public key here, and every
 * build from that point on refuses an update it cannot verify.
 */
export const RELEASE_PUBLIC_KEY_PEM: string | null = null
