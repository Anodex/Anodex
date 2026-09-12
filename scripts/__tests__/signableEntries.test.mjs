import { describe, expect, it } from 'vitest'
import { signableEntries } from '../signable-entries.mjs'

/**
 * What the release signer is willing to open.
 *
 * This is the check that was missing when v0.4.0 failed to package. The signer
 * walked `dist/`, opened every entry to hash it, and hit electron-builder's
 * staging tree:
 *
 *     [Error: EISDIR: illegal operation on a directory, read]
 *
 * Every platform, every tag, the moment the `--manifest` path was used for real.
 * Nothing caught it earlier because the manifest path was written after v0.3.0
 * had already shipped, so its first run was a release build.
 */
const entry = (name, isFile = true) => ({ name, isFile: () => isFile })

describe('signableEntries', () => {
  it('does not try to open a directory', () => {
    // The exact failure. electron-builder leaves this beside the artifact on
    // every platform, named differently on each.
    for (const staging of ['linux-unpacked', 'win-unpacked', 'mac-arm64']) {
      const signable = signableEntries([entry('Anodex-0.4.0.AppImage'), entry(staging, false)])
      expect(signable).toEqual(['Anodex-0.4.0.AppImage'])
    }
  })

  it('keeps the installers, which are the point', () => {
    // Named as the three platforms actually produce them, spaces and all — the
    // Windows installer has them on disk and loses them when published.
    const signable = signableEntries(
      [
        'Anodex Setup 0.4.0.exe',
        'Anodex-0.4.0-arm64.dmg',
        'Anodex-0.4.0.AppImage',
        'linux-unpacked'
      ].map((name) => entry(name, name !== 'linux-unpacked'))
    )

    expect(signable).toEqual([
      'Anodex Setup 0.4.0.exe',
      'Anodex-0.4.0-arm64.dmg',
      'Anodex-0.4.0.AppImage'
    ])
  })

  it('skips what describes the release rather than being it', () => {
    // Metadata, this script's own output from a previous run, and the delta
    // index. Hashing a 300 MB blockmap costs a full read to match nothing.
    const signable = signableEntries(
      ['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'x.exe.sig', 'x.exe.blockmap'].map((n) =>
        entry(n)
      )
    )

    expect(signable).toEqual([])
  })

  it('does not mistake a directory for metadata, or the reverse', () => {
    // A directory whose name ends in one of the ignored suffixes, and a file
    // whose name merely contains one. Both are decided by the same predicate,
    // and getting either backwards drops a real artifact or opens a directory.
    const signable = signableEntries([
      entry('latest.yml', false),
      entry('Anodex-0.4.0.yml.AppImage')
    ])

    expect(signable).toEqual(['Anodex-0.4.0.yml.AppImage'])
  })

  it('an empty dist is empty, not an error', () => {
    // The caller reports "nothing to sign" with its own message; this should
    // not be the thing that throws first.
    expect(signableEntries([])).toEqual([])
  })
})
