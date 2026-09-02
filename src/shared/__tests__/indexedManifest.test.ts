import { describe, expect, it } from 'vitest'
import { indexedManifest } from '../indexedManifest'

/**
 * The manifest is what decides whether a file gets indexed again, so recording
 * a file it never indexed makes the omission permanent.
 *
 * `CodeIndexer.reconcile` saved `currentManifest` — every walked file — no
 * matter how much of it actually reached the index. There is a cap
 * (`MAX_INDEXED_CHUNKS`, 20,000) and the chunk loop breaks on it, so on a large
 * enough project the files late in the walk contribute nothing while still
 * being written into the manifest as current.
 *
 * `diffManifest` then sees no change for them on the next pass, so they are
 * never retried — not when other files are deleted, not when the cap frees up,
 * not ever, until the file itself is edited. `search_code` silently stops
 * covering whole files and nothing says so.
 *
 * Reachable rather than hypothetical: the largest real index on this machine
 * holds 6,009 chunks from 940 files, about 6.4 chunks each, so a project of
 * roughly three thousand indexable files crosses the cap.
 */
describe('indexedManifest', () => {
  const walked = {
    'a.ts': { size: 1, mtimeMs: 10 },
    'b.ts': { size: 2, mtimeMs: 20 },
    'c.ts': { size: 3, mtimeMs: 30 }
  }

  it('records only the files that were actually indexed', () => {
    expect(indexedManifest(walked, ['a.ts', 'b.ts'])).toEqual({
      'a.ts': { size: 1, mtimeMs: 10 },
      'b.ts': { size: 2, mtimeMs: 20 }
    })
  })

  it('omits a file the cap cut off, so it is retried', () => {
    // The whole point: `c.ts` stays absent, so `diffManifest` reports it as new
    // next time and it gets another chance once there is room.
    expect(indexedManifest(walked, ['a.ts', 'b.ts'])).not.toHaveProperty('c.ts')
  })

  it('keeps the walked size and mtime, not a placeholder', () => {
    // The manifest is compared against a fresh stat; a wrong value here would
    // make an unchanged file look changed on every pass.
    expect(indexedManifest(walked, ['b.ts'])['b.ts']).toEqual({ size: 2, mtimeMs: 20 })
  })

  it('ignores an indexed path that is no longer on disk', () => {
    // A file deleted between the walk and the save has no manifest entry to
    // copy, and inventing one would resurrect it as permanently current.
    expect(indexedManifest(walked, ['a.ts', 'gone.ts'])).toEqual({
      'a.ts': { size: 1, mtimeMs: 10 }
    })
  })

  it('returns nothing when nothing was indexed', () => {
    expect(indexedManifest(walked, [])).toEqual({})
  })

  it('does not mutate the walked manifest', () => {
    const before = JSON.stringify(walked)
    indexedManifest(walked, ['a.ts'])
    expect(JSON.stringify(walked)).toBe(before)
  })
})
