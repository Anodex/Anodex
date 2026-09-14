import { describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@shared/conversation.types'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../../broadcast', () => ({ broadcastToOtherClients: vi.fn() }))
vi.mock('../../clients/clientRegistry', () => ({
  isRemoteCall: () => true,
  resolveClientChannel: () => ({ id: 'phone' })
}))
vi.mock('../../conversations/ConversationStore', () => ({ conversationStore: {} }))
vi.mock('../../conversations/ConversationAssetStore', () => ({ conversationAssetStore: {} }))
vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

import {
  assertMessagesLoaded,
  summariesOf,
  thinkingOf,
  withoutMessages
} from '../conversation.handlers'

const chat = (id: string, messages: Conversation['messages'] = []): Conversation => ({
  id,
  projectId: null,
  title: id,
  createdAt: 1,
  updatedAt: 2,
  messages
})

describe('summariesOf', () => {
  const store = [chat('a'), chat('b'), chat('c')]

  it('lists every conversation when no ids are given, as it always has', () => {
    expect(summariesOf(store).map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('lists only the named ones, and simply leaves out one that is gone', () => {
    // A phone told one conversation changed reads that row, not the whole store.
    expect(summariesOf(store, ['b', 'gone']).map((s) => s.id)).toEqual(['b'])
    expect(summariesOf(store, [])).toEqual([])
  })
})

describe('thinkingOf', () => {
  const conversation = chat('a', [
    { id: 'q', role: 'user', content: 'Why?', createdAt: 1 },
    { id: 'q:reply', role: 'assistant', content: 'Because.', createdAt: 1, thinking: 'Hmm.' },
    { id: 'r:reply', role: 'assistant', content: 'Sure.', createdAt: 1, thinking: '  ' }
  ])

  it("reads one reply's thinking", () => {
    expect(thinkingOf(conversation, 'q:reply')).toBe('Hmm.')
  })

  it('answers null for a reply without any, a missing message or conversation', () => {
    expect(thinkingOf(conversation, 'r:reply')).toBeNull()
    expect(thinkingOf(conversation, 'nope')).toBeNull()
    expect(thinkingOf(null, 'q:reply')).toBeNull()
  })
})

describe('the window listing conversations without their messages', () => {
  const stored = chat('a', [{ id: 'q', role: 'user', content: 'Why?', createdAt: 1 }])

  it('lists everything but the messages, and says so', () => {
    const listed = withoutMessages(stored)
    expect(listed).toMatchObject({ id: 'a', title: 'a', messages: [], messagesNotLoaded: true })
  })

  it('refuses to save a copy whose messages were never read', () => {
    // Saved, it would replace the conversation on disk with no messages at all.
    expect(() => assertMessagesLoaded(withoutMessages(stored))).toThrow(/not loaded/)
    expect(() => assertMessagesLoaded(stored)).not.toThrow()
  })
})
