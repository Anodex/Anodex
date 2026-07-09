import { describe, expect, it } from 'vitest'
import type { Conversation } from '@shared/conversation.types'
import { conversationsRelevantlyEqual } from '../conversationEquality'

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    projectId: null,
    title: 'Chat',
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('conversationsRelevantlyEqual', () => {
  it('treats a token-only content change as equal', () => {
    // Regression test: appending a streamed token deep in message content
    // must not be seen as a relevant change — that's exactly the churn that
    // was starving window-resize repaints and popup dismiss timers.
    const a = [
      makeConversation({
        messages: [{ id: 'm1', role: 'assistant', content: 'Hello', createdAt: 0, streaming: true }]
      })
    ]
    const b = [
      makeConversation({
        messages: [
          { id: 'm1', role: 'assistant', content: 'Hello world', createdAt: 0, streaming: true }
        ]
      })
    ]
    expect(conversationsRelevantlyEqual(a, b)).toBe(true)
  })

  it('treats a title change as different', () => {
    const a = [makeConversation({ title: 'Old title' })]
    const b = [makeConversation({ title: 'New title' })]
    expect(conversationsRelevantlyEqual(a, b)).toBe(false)
  })

  it('treats an updatedAt change as different', () => {
    const a = [makeConversation({ updatedAt: 1 })]
    const b = [makeConversation({ updatedAt: 2 })]
    expect(conversationsRelevantlyEqual(a, b)).toBe(false)
  })

  it('treats a projectId change as different', () => {
    const a = [makeConversation({ projectId: null })]
    const b = [makeConversation({ projectId: 'p1' })]
    expect(conversationsRelevantlyEqual(a, b)).toBe(false)
  })

  it('treats a new message being added as different', () => {
    const a = [makeConversation({ messages: [] })]
    const b = [
      makeConversation({
        messages: [{ id: 'm1', role: 'user', content: 'hi', createdAt: 0 }]
      })
    ]
    expect(conversationsRelevantlyEqual(a, b)).toBe(false)
  })

  it('treats the streaming flag flipping off as different', () => {
    const a = [
      makeConversation({
        messages: [{ id: 'm1', role: 'assistant', content: 'Done', createdAt: 0, streaming: true }]
      })
    ]
    const b = [
      makeConversation({
        messages: [{ id: 'm1', role: 'assistant', content: 'Done', createdAt: 0, streaming: false }]
      })
    ]
    expect(conversationsRelevantlyEqual(a, b)).toBe(false)
  })

  it('treats a different array length as different', () => {
    const a = [makeConversation({ id: 'c1' })]
    const b = [makeConversation({ id: 'c1' }), makeConversation({ id: 'c2' })]
    expect(conversationsRelevantlyEqual(a, b)).toBe(false)
  })

  it('treats the same reference as equal without iterating', () => {
    const a = [makeConversation()]
    expect(conversationsRelevantlyEqual(a, a)).toBe(true)
  })
})
