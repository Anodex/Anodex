import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@shared/conversation.types'

// `lib/anodex` dereferences `window.anodex` at import time — there is no
// window in the node test environment, so the preload bridge is stubbed out.
vi.mock('../../lib/anodex', () => ({ anodex: {} }))

import { useChatStore } from '../chatStore'

function seedConversation(streaming: boolean): Conversation {
  return {
    id: 'c1',
    projectId: null,
    title: 'Test chat',
    createdAt: 1,
    updatedAt: 1,
    messages: [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: 'partial reply',
        createdAt: 1,
        streaming,
        blocks: [{ type: 'text', text: 'partial reply' }]
      }
    ]
  }
}

function assistantMessage() {
  return useChatStore.getState().conversations[0].messages[1]
}

describe('chatStore token streaming guards', () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: [seedConversation(true)],
      activeId: 'c1',
      loaded: true,
      pendingMessages: {}
    })
  })

  it('appends tokens to a message that is still streaming', () => {
    useChatStore.getState().appendToken('c1', 'a1', ' more')
    expect(assistantMessage().content).toBe('partial reply more')
  })

  it('drops a late token flush once the message finished streaming', () => {
    // The regression: tokens are rAF-batched in useAnodexBridge, while
    // sendMessage's finalize resolves on the un-throttled IPC promise — a
    // buffered final frame of tokens can flush AFTER finalize has already
    // replaced `content` with the complete reply, duplicating its tail.
    useChatStore.setState({ conversations: [seedConversation(false)] })
    useChatStore.getState().appendToken('c1', 'a1', 'partial reply')
    expect(assistantMessage().content).toBe('partial reply')
    expect(assistantMessage().blocks).toHaveLength(1)
  })

  it('drops a late thinking-token flush once the message finished streaming', () => {
    useChatStore.setState({ conversations: [seedConversation(false)] })
    useChatStore.getState().appendThinkingToken('c1', 'a1', 'stale thought')
    expect(assistantMessage().thinking).toBeUndefined()
  })

  it('still appends thinking tokens while streaming', () => {
    useChatStore.getState().appendThinkingToken('c1', 'a1', 'thinking…')
    expect(assistantMessage().thinking).toBe('thinking…')
  })

  it('still applies a late tool-activity flush after streaming ends — terminal statuses must not be lost', () => {
    useChatStore.setState({ conversations: [seedConversation(false)] })
    useChatStore
      .getState()
      .applyToolActivityBatch('c1', 'a1', [
        { id: 't1', name: 'read_file', kind: 'read', title: 'Read foo.ts', status: 'success' }
      ])
    expect(assistantMessage().toolCalls?.[0]?.status).toBe('success')
  })

  it('ignores tokens for unknown conversations or messages without throwing', () => {
    useChatStore.getState().appendToken('nope', 'a1', 'x')
    useChatStore.getState().appendToken('c1', 'nope', 'x')
    expect(assistantMessage().content).toBe('partial reply')
  })
})

describe('openEmailThreadConversation', () => {
  function emailChat(id: string, accountId: string, threadId: string): Conversation {
    return {
      id,
      projectId: null,
      title: 'Email chat',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      emailThread: { accountId, threadId }
    }
  }

  beforeEach(() => {
    useChatStore.setState({ conversations: [], activeId: null, loaded: true, pendingMessages: {} })
  })

  it('reuses the chat already linked to that thread instead of starting another', () => {
    // Clicking Reply twice on one email used to spawn two chats, losing the
    // earlier discussion each time.
    useChatStore.setState({ conversations: [emailChat('c-email', 'acct-1', 'thread-1')] })

    const id = useChatStore.getState().openEmailThreadConversation('acct-1', 'thread-1')

    expect(id).toBe('c-email')
    expect(useChatStore.getState().activeId).toBe('c-email')
    expect(useChatStore.getState().conversations).toHaveLength(1)
  })

  it('starts a linked chat when the thread has none', () => {
    const id = useChatStore.getState().openEmailThreadConversation('acct-1', 'thread-1')

    const created = useChatStore.getState().conversations.find((c) => c.id === id)
    expect(created?.emailThread).toEqual({ accountId: 'acct-1', threadId: 'thread-1' })
    expect(useChatStore.getState().activeId).toBe(id)
  })

  it('does not reuse a chat from a different account with the same thread id', () => {
    // IMAP thread ids are derived from the subject, so two accounts can easily
    // produce the same one for unrelated mail.
    useChatStore.setState({ conversations: [emailChat('c-email', 'acct-1', 'thread-1')] })

    const id = useChatStore.getState().openEmailThreadConversation('acct-2', 'thread-1')

    expect(id).not.toBe('c-email')
    expect(useChatStore.getState().conversations).toHaveLength(2)
  })

  it('starts a fresh chat once the linked one is gone', () => {
    // Archived and deleted chats are removed from `conversations`, so an empty
    // list is exactly the "no longer alive" case.
    useChatStore.setState({ conversations: [] })

    const id = useChatStore.getState().openEmailThreadConversation('acct-1', 'thread-1')

    expect(useChatStore.getState().conversations.find((c) => c.id === id)).toBeDefined()
  })
})
