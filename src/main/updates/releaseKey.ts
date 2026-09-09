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
 * Set once, for the life of the key — not per release. Signing a release reads
 * the private half from a file on the release machine; nothing is pasted here
 * again, and rotating is the only thing that would change this line.
 *
 * `null` would mean a build compiled before a key existed: the check inert and
 * updates behaving exactly as they did before. That is the honest fallback
 * rather than a guarantee it cannot make, and it is what every build before
 * this commit did.
 */
export const RELEASE_PUBLIC_KEY_PEM: string | null = `
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA29uDSdOJPyMRqyuJ1r9k6hkRmgaYNJzzjCmJU+EPM1g=
-----END PUBLIC KEY-----
`
