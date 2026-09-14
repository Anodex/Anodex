import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../lib/anodex', () => ({ anodex: { conversations: { search: vi.fn() } } }))

import { matchesFromHits, matchesQuery } from '../conversationSearch'

describe('matchesQuery', () => {
  it('matches case-insensitively', () => {
    expect(matchesQuery('Deploy Notes', 'deploy')).toBe(true)
    expect(matchesQuery('Deploy Notes', 'DEPLOY')).toBe(true)
    expect(matchesQuery('Deploy Notes', 'rollback')).toBe(false)
  })
})

/**
 * The sidebar's body search runs on the computer now — the window no longer holds
 * every conversation's messages. `conversationBodySearch.test.ts` covers the ranking.
 */
describe('matchesFromHits', () => {
  it('surfaces each conversation the computer found, with the passage that matched', () => {
    const matches = matchesFromHits([
      { conversationId: 'c1', excerpt: 'How do I configure the postgres connection pool?' },
      { conversationId: 'c2', excerpt: '' }
    ])
    expect([...matches.ids]).toEqual(['c1', 'c2'])
    expect(matches.excerpts.get('c1')).toContain('postgres')
    expect(matches.excerpts.has('c2')).toBe(false)
  })

  it('is empty for no hits', () => {
    expect(matchesFromHits([]).ids.size).toBe(0)
  })
})
