import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { MemoryEntry, MemoryScope } from '@shared/memory.types'
import { buildMemoryContext, scoreEntries } from '../MemoryRetriever'

const listMock = vi.fn<(scope: MemoryScope) => MemoryEntry[]>()

// Hoisted by vitest above the imports above, so `MemoryRetriever` picks up this mock.
vi.mock('../MemoryStore', () => ({
  memoryStore: { list: (scope: MemoryScope) => listMock(scope) }
}))

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

describe('scoreEntries', () => {
  it('ranks pinned entries first regardless of overlap or recency', () => {
    const pinned = entry({ id: 'pinned', text: 'unrelated text', updatedAt: 1, pinned: true })
    const recent = entry({ id: 'recent', text: 'matches the prompt exactly', updatedAt: 100 })
    const ranked = scoreEntries([recent, pinned], 'matches the prompt exactly')
    expect(ranked[0].id).toBe('pinned')
  })

  it('ranks higher lexical overlap with the prompt above lower overlap', () => {
    const highOverlap = entry({ id: 'high', text: 'uses vite for the build pipeline' })
    const lowOverlap = entry({ id: 'low', text: 'completely unrelated fact' })
    const ranked = scoreEntries([lowOverlap, highOverlap], 'how does the vite build pipeline work')
    expect(ranked[0].id).toBe('high')
  })

  it('falls back to most-recently-updated when overlap ties', () => {
    const older = entry({ id: 'older', text: 'no overlap here', updatedAt: 1 })
    const newer = entry({ id: 'newer', text: 'no overlap here either', updatedAt: 2 })
    const ranked = scoreEntries([older, newer], 'something else entirely')
    expect(ranked[0].id).toBe('newer')
  })

  it('ranks identity facts ahead of higher-overlap non-identity facts', () => {
    // The exact real failure this guards against: "what's my name?" shares no
    // words at all with "The user's name is Gabe." — identity facts must
    // still surface even with zero lexical overlap with the query.
    const identity = entry({ id: 'identity', kind: 'identity', text: "The user's name is Gabe." })
    const highOverlap = entry({ id: 'overlap', text: 'likes color blue preference setting' })
    const ranked = scoreEntries([highOverlap, identity], 'what color blue preference setting')
    expect(ranked[0].id).toBe('identity')
  })

  it('still ranks pinned entries ahead of identity facts', () => {
    const identity = entry({ id: 'identity', kind: 'identity', text: 'name is Gabe' })
    const pinned = entry({ id: 'pinned', text: 'unrelated pinned fact', pinned: true })
    const ranked = scoreEntries([identity, pinned], 'anything')
    expect(ranked[0].id).toBe('pinned')
  })
})

describe('buildMemoryContext', () => {
  beforeEach(() => {
    listMock.mockReset()
  })

  it('returns null when both scopes are disabled', () => {
    const result = buildMemoryContext('project-1', 'anything', {
      crossChatEnabled: false,
      personalEnabled: false
    })
    expect(result).toBeNull()
    expect(listMock).not.toHaveBeenCalled()
  })

  it('returns null when there are no entries', () => {
    listMock.mockReturnValue([])
    const result = buildMemoryContext('project-1', 'anything', {
      crossChatEnabled: true,
      personalEnabled: true
    })
    expect(result).toBeNull()
  })

  it('formats entries as a bullet list with kind and scope, and returns the entries used', () => {
    const g1 = entry({ id: 'g1', text: 'Prefers pnpm.', kind: 'preference' })
    listMock.mockImplementation((scope) => (scope.type === 'global' ? [g1] : []))
    const result = buildMemoryContext(null, 'pnpm preference', {
      crossChatEnabled: true,
      personalEnabled: true
    })
    expect(result?.text).toBe('- [preference] Prefers pnpm. (global)')
    expect(result?.entries).toEqual([g1])
  })

  it('does not fetch project-scoped entries when cross-chat memory is off', () => {
    listMock.mockReturnValue([])
    buildMemoryContext('project-1', 'anything', { crossChatEnabled: false, personalEnabled: true })
    expect(listMock).toHaveBeenCalledTimes(1)
    expect(listMock).toHaveBeenCalledWith({ type: 'global' })
  })

  it('caps the number of entries returned', () => {
    const many = Array.from({ length: 20 }, (_, i) => entry({ id: `${i}`, text: `fact ${i}` }))
    listMock.mockImplementation((scope) => (scope.type === 'global' ? many : []))
    const result = buildMemoryContext(null, 'fact anything', {
      crossChatEnabled: true,
      personalEnabled: true
    })
    expect(result?.text.split('\n')).toHaveLength(8)
    expect(result?.entries).toHaveLength(8)
  })

  it('omits ordinary memories with no prompt overlap', () => {
    const unrelated = entry({ id: 'unrelated', text: 'Uses vite for frontend builds.' })
    listMock.mockImplementation((scope) => (scope.type === 'global' ? [unrelated] : []))
    const result = buildMemoryContext(null, 'what is my name', {
      crossChatEnabled: true,
      personalEnabled: true
    })
    expect(result).toBeNull()
  })

  it('still retrieves identity and pinned memories without prompt overlap', () => {
    const identity = entry({ id: 'identity', kind: 'identity', text: "The user's name is Gabe." })
    const pinned = entry({ id: 'pinned', text: 'Uses pnpm.', pinned: true })
    listMock.mockImplementation((scope) => (scope.type === 'global' ? [pinned, identity] : []))
    const result = buildMemoryContext(null, 'anything unrelated', {
      crossChatEnabled: true,
      personalEnabled: true
    })
    expect(result?.entries.map((e) => e.id)).toEqual(['pinned', 'identity'])
  })

  it('truncates a single oversized legacy entry to the memory section cap', () => {
    const long = entry({ id: 'long', kind: 'identity', text: 'x'.repeat(2_000) })
    listMock.mockImplementation((scope) => (scope.type === 'global' ? [long] : []))
    const result = buildMemoryContext(null, 'anything', {
      crossChatEnabled: true,
      personalEnabled: true
    })
    expect(result?.text.length).toBeLessThanOrEqual(1500)
    expect(result?.entries).toEqual([long])
  })
})
