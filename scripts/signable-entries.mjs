/**
 * Which entries in `dist/` are candidates for signing.
 *
 * Extracted from `sign-release.mjs` so it can be tested, because the thing it
 * gets wrong is not visible until a real release is being built.
 *
 * `dist/` is not a flat pile of installers. electron-builder leaves the staging
 * tree beside the artifacts — `linux-unpacked/` on Linux, `win-unpacked/` on
 * Windows, `mac-arm64/` on macOS — and the first release built through the
 * `--manifest` path walked the directory, opened everything in it, and died on
 * the first one of those with:
 *
 *     [Error: EISDIR: illegal operation on a directory, read]
 *
 * A directory is not a corrupt artifact and not a missing one; it is simply not
 * a file, and hashing it was never going to mean anything.
 */
export function signableEntries(entries) {
  return entries.filter((entry) => entry.isFile() && !IGNORED.test(entry.name)).map((e) => e.name)
}

/**
 * Metadata and signatures, which describe the artifacts rather than being them.
 *
 * `latest*.yml` is what says which files the release contains, a `.sig` is this
 * script's own output, and a `.blockmap` is electron-updater's delta index —
 * none of the three is declared in the manifest, so hashing them only wastes a
 * pass over a large file.
 */
const IGNORED = /\.(yml|sig|blockmap)$/
