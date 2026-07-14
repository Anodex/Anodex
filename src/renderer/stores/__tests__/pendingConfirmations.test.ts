import { describe, expect, it } from 'vitest'
import type { ToolConfirmRequest } from '@shared/tools.types'
import {
  appendPendingConfirmation,
  confirmationsForConversation,
  removePendingConfirmation
} from '../pendingConfirmations'

function makeRequest(id: string, conversationId = 'conv-1'): ToolConfirmRequest {
  return {
    id,
    conversationId,
    messageId: 'msg-1',
    toolName: 'write_file',
    kind: 'write',
    title: 'Apply file change?',
    detail: 'foo.ts',
    risk: 'safe'
  }
}

describe('appendPendingConfirmation', () => {
  it('adds to an empty queue', () => {
    const result = appendPendingConfirmation([], makeRequest('a'))
    expect(result.map((r) => r.id)).toEqual(['a'])
  })

  it('appends without disturbing already-pending requests', () => {
    const existing = [makeRequest('a')]
    const result = appendPendingConfirmation(existing, makeRequest('b'))
    expect(result.map((r) => r.id)).toEqual(['a', 'b'])
    expect(existing.map((r) => r.id)).toEqual(['a']) // original array untouched
  })
})

describe('removePendingConfirmation', () => {
  it('removes only the matching id, leaving others pending', () => {
    const pending = [makeRequest('a'), makeRequest('b'), makeRequest('c')]
    const result = removePendingConfirmation(pending, 'b')
    expect(result.map((r) => r.id)).toEqual(['a', 'c'])
  })

  it('is a safe no-op for an unknown id, returning the same array reference', () => {
    const pending = [makeRequest('a')]
    const result = removePendingConfirmation(pending, 'does-not-exist')
    expect(result).toBe(pending)
  })

  it('empties the queue when removing the last pending request', () => {
    const result = removePendingConfirmation([makeRequest('a')], 'a')
    expect(result).toEqual([])
  })
})

describe('confirmationsForConversation', () => {
  it('keeps only requests belonging to the given conversation', () => {
    const pending = [
      makeRequest('a', 'conv-active'),
      makeRequest('b', 'conv-background'),
      makeRequest('c', 'conv-active')
    ]

    expect(confirmationsForConversation(pending, 'conv-active').map((r) => r.id)).toEqual([
      'a',
      'c'
    ])
  })

  it('excludes every request belonging to a different, background conversation', () => {
    // The scenario this exists for: a second conversation generating in the
    // background adds its own pending request to the same global queue while
    // the user is looking at a different one — that request must never show
    // up (or be reachable by "Approve all") in the conversation on screen.
    const pending = [makeRequest('background-write', 'conv-background')]

    expect(confirmationsForConversation(pending, 'conv-active')).toEqual([])
  })

  it('returns nothing when there is no active conversation', () => {
    const pending = [makeRequest('a', 'conv-1')]

    expect(confirmationsForConversation(pending, null)).toEqual([])
  })

  it('returns an empty array, not a filtered reference, for an empty queue', () => {
    expect(confirmationsForConversation([], 'conv-1')).toEqual([])
  })
})
