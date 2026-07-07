import { describe, expect, it } from 'vitest'
import {
  MAX_MEMORY_TEXT_CHARS,
  capEntries,
  findSimilarEntry,
  normalizeMemoryText,
  validateMemoryScope
} from '../MemoryStore'
import type { MemoryEntry, MemoryScope } from '@shared/memory.types'

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? Math.random().toString(36),
    kind: 'convention',
    text: 'some fact',
    scope: { type: 'global' },
    createdAt: 0,
    updatedAt: 0,
    pinned: false,
    archived: false,
    ...overrides
  }
}

describe('capEntries', () => {
  it('leaves the list untouched when under the cap', () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry({ id: `${i}` }))
    expect(capEntries(entries)).toEqual(entries)
  })

  it('evicts the oldest unpinned entries once over the cap, keeping newest-first order', () => {
    // 201 unpinned entries, newest first (index 0 is newest) — one over the 200 cap.
    const entries = Array.from({ length: 201 }, (_, i) => entry({ id: `${i}` }))
    const capped = capEntries(entries)

    expect(capped).toHaveLength(200)
    expect(capped.map((e) => e.id)).not.toContain('200')
    expect(capped[0].id).toBe('0')
  })

  it('never evicts pinned entries, even past the cap', () => {
    const pinned = Array.from({ length: 10 }, (_, i) => entry({ id: `pinned-${i}`, pinned: true }))
    const unpinned = Array.from({ length: 195 }, (_, i) => entry({ id: `unpinned-${i}` }))
    const capped = capEntries([...pinned, ...unpinned])

    for (const p of pinned) expect(capped).toContainEqual(p)
    expect(capped).toHaveLength(200)
  })
})

describe('findSimilarEntry', () => {
  it('matches a near-restatement of the same fact, same kind', () => {
    const existing = entry({ id: 'e1', kind: 'identity', text: "The user's name is Gabe." })
    const found = findSimilarEntry([existing], 'identity', 'The user is named Gabe.')
    expect(found?.id).toBe('e1')
  })

  it('does not match a different kind even with identical text', () => {
    const existing = entry({ id: 'e1', kind: 'identity', text: 'Likes the color blue.' })
    const found = findSimilarEntry([existing], 'preference', 'Likes the color blue.')
    expect(found).toBeUndefined()
  })

  it('does not match unrelated text of the same kind', () => {
    const existing = entry({ id: 'e1', kind: 'preference', text: 'Prefers pnpm over npm.' })
    const found = findSimilarEntry([existing], 'preference', 'Likes dark mode UI.')
    expect(found).toBeUndefined()
  })

  it('ignores archived entries', () => {
    const existing = entry({
      id: 'e1',
      kind: 'identity',
      text: "The user's name is Gabe.",
      archived: true
    })
    const found = findSimilarEntry([existing], 'identity', 'The user is named Gabe.')
    expect(found).toBeUndefined()
  })
})

describe('validateMemoryScope', () => {
  it('accepts global and safe project scopes', () => {
    expect(() => validateMemoryScope({ type: 'global' })).not.toThrow()
    expect(() =>
      validateMemoryScope({ type: 'project', projectId: 'p_lz6abc_12345' })
    ).not.toThrow()
  })

  it('rejects path traversal project ids', () => {
    const scope = { type: 'project', projectId: '../settings' } as MemoryScope
    expect(() => validateMemoryScope(scope)).toThrow('Invalid memory scope.')
  })
})

describe('normalizeMemoryText', () => {
  it('trims and caps memory text', () => {
    const text = `  ${'a'.repeat(MAX_MEMORY_TEXT_CHARS + 20)}  `
    expect(normalizeMemoryText(text)).toHaveLength(MAX_MEMORY_TEXT_CHARS)
  })
})
