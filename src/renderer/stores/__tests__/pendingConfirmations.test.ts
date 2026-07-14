import { describe, expect, it } from 'vitest'
import type { ToolConfirmRequest } from '@shared/tools.types'
import { appendPendingConfirmation, removePendingConfirmation } from '../pendingConfirmations'

function makeRequest(id: string): ToolConfirmRequest {
  return {
    id,
    conversationId: 'conv-1',
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
