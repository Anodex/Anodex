import { describe, expect, it } from 'vitest'
import { diffManifest } from '../codeIndexManifest'

describe('diffManifest', () => {
  it('flags a brand-new file as changed', () => {
    const diff = diffManifest({}, { 'a.ts': { size: 10, mtimeMs: 1 } })
    expect(diff.changedOrNew).toEqual(['a.ts'])
    expect(diff.removed).toEqual([])
  })

  it('ignores a file whose size and mtime are unchanged', () => {
    const prior = { 'a.ts': { size: 10, mtimeMs: 1 } }
    const diff = diffManifest(prior, { 'a.ts': { size: 10, mtimeMs: 1 } })
    expect(diff.changedOrNew).toEqual([])
    expect(diff.removed).toEqual([])
  })

  it('flags a file whose mtime changed even if size did not', () => {
    const prior = { 'a.ts': { size: 10, mtimeMs: 1 } }
    const diff = diffManifest(prior, { 'a.ts': { size: 10, mtimeMs: 2 } })
    expect(diff.changedOrNew).toEqual(['a.ts'])
  })

  it('flags a file whose size changed even if mtime did not', () => {
    const prior = { 'a.ts': { size: 10, mtimeMs: 1 } }
    const diff = diffManifest(prior, { 'a.ts': { size: 20, mtimeMs: 1 } })
    expect(diff.changedOrNew).toEqual(['a.ts'])
  })

  it('flags a file removed from disk', () => {
    const prior = { 'a.ts': { size: 10, mtimeMs: 1 } }
    const diff = diffManifest(prior, {})
    expect(diff.changedOrNew).toEqual([])
    expect(diff.removed).toEqual(['a.ts'])
  })

  it('handles a mix of unchanged, changed, new, and removed files in one pass', () => {
    const prior = {
      unchanged: { size: 5, mtimeMs: 1 },
      changed: { size: 5, mtimeMs: 1 },
      gone: { size: 5, mtimeMs: 1 }
    }
    const current = {
      unchanged: { size: 5, mtimeMs: 1 },
      changed: { size: 6, mtimeMs: 1 },
      brandNew: { size: 5, mtimeMs: 1 }
    }
    const diff = diffManifest(prior, current)
    expect(diff.changedOrNew.sort()).toEqual(['brandNew', 'changed'])
    expect(diff.removed).toEqual(['gone'])
  })
})
