import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@shared/conversation.types'

const listConversations = vi.hoisted(() => vi.fn<() => Promise<Conversation[]>>())

// `lib/anodex` dereferences `window.anodex` at import time — there is no
// window in the node test environment, so the preload bridge is stubbed out.
vi.mock('../../lib/anodex', () => ({
  anodex: {
    // Only the persistence calls the tested actions make; everything else on
    // the bridge stays absent so an unexpected call fails loudly.
    conversations: {
      save: vi.fn().mockResolvedValue(undefined),
      setState: vi.fn().mockResolvedValue(undefined),
      deletePermanent: vi.fn().mockResolvedValue(undefined),
      list: listConversations
    }
  }
}))

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

  it('refreshes which message a reply should answer when reopening the thread', () => {
    // A thread grows. Reopening it after new mail arrives has to point the
    // model at the new message, not the one that was newest when the chat
    // started — otherwise the reply answers stale mail.
    useChatStore.setState({ conversations: [emailChat('c-email', 'acct-1', 'thread-1')] })

    useChatStore.getState().openEmailThreadConversation('acct-1', 'thread-1', {
      subject: 'Q3 renewal',
      latestMessageId: 'msg-9'
    })

    const chat = useChatStore.getState().conversations[0]
    expect(chat.emailThread).toEqual({
      accountId: 'acct-1',
      threadId: 'thread-1',
      subject: 'Q3 renewal',
      latestMessageId: 'msg-9'
    })
  })

  it('drops a thread chat that was opened but never used', () => {
    // Reading mail must not litter the sidebar: the rail links a chat on every
    // thread opened, and most of them are never asked a question.
    useChatStore.setState({ conversations: [emailChat('c-email', 'acct-1', 'thread-1')] })

    useChatStore.getState().discardUnusedEmailThreadConversation('c-email')

    expect(useChatStore.getState().conversations).toHaveLength(0)
  })

  it('keeps a thread chat that has turns in it', () => {
    const used = emailChat('c-email', 'acct-1', 'thread-1')
    used.messages = [{ id: 'u1', role: 'user', content: 'Summarize this.', createdAt: 1 }]
    useChatStore.setState({ conversations: [used] })

    useChatStore.getState().discardUnusedEmailThreadConversation('c-email')

    expect(useChatStore.getState().conversations).toHaveLength(1)
  })

  it('keeps an empty thread chat while an instruction is still in the composer', () => {
    // Clicking Reply and then navigating away is work in progress, not an
    // abandoned chat.
    useChatStore.setState({
      conversations: [emailChat('c-email', 'acct-1', 'thread-1')],
      pendingComposerText: 'Draft a reply to this email.'
    })

    useChatStore.getState().discardUnusedEmailThreadConversation('c-email')

    expect(useChatStore.getState().conversations).toHaveLength(1)
  })

  it('never discards an ordinary chat that has no email thread', () => {
    useChatStore.setState({
      conversations: [
        {
          id: 'c-plain',
          projectId: null,
          title: 'New chat',
          createdAt: 1,
          updatedAt: 1,
          messages: []
        }
      ]
    })

    useChatStore.getState().discardUnusedEmailThreadConversation('c-plain')

    expect(useChatStore.getState().conversations).toHaveLength(1)
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

/**
 * A turn in progress exists only in renderer state — `sendMessage` persists it
 * once, at completion. Anything that reloads the conversation list mid-turn
 * therefore has to keep it, or the user's message and the reply streaming into
 * it are both discarded with no error anywhere.
 *
 * `useAnodexBridge` refreshes on every scheduler and agent-run broadcast, and a
 * run broadcasts once per turn, so this is the ordinary case rather than a
 * corner one.
 */
describe('refreshing the conversation list mid-turn', () => {
  /** The same conversation as it exists on disk: without the unfinished turn. */
  function persistedVersion(): Conversation {
    return {
      id: 'c1',
      projectId: null,
      title: 'Test chat',
      createdAt: 1,
      updatedAt: 1,
      messages: []
    }
  }

  beforeEach(() => {
    listConversations.mockReset()
    useChatStore.setState({
      conversations: [seedConversation(true)],
      activeId: 'c1',
      loaded: true,
      pendingMessages: {}
    })
  })

  it('keeps the streaming turn instead of the truncated version on disk', async () => {
    listConversations.mockResolvedValue([persistedVersion()])

    await useChatStore.getState().refreshConversations()

    const [conversation] = useChatStore.getState().conversations
    expect(conversation.messages.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(conversation.messages[1].streaming).toBe(true)
  })

  it('keeps a still-generating conversation that is absent from disk', async () => {
    listConversations.mockResolvedValue([])

    await useChatStore.getState().refreshConversations()

    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['c1'])
  })

  it('takes the loaded version once nothing is streaming', async () => {
    useChatStore.setState({ conversations: [seedConversation(false)] })
    listConversations.mockResolvedValue([{ ...persistedVersion(), title: 'Renamed elsewhere' }])

    await useChatStore.getState().refreshConversations()

    const [conversation] = useChatStore.getState().conversations
    expect(conversation.title).toBe('Renamed elsewhere')
    expect(conversation.messages).toHaveLength(0)
  })

  it('still picks up conversations created elsewhere while a turn streams', async () => {
    // The reason the refresh exists: an agent run writes its own conversation
    // in the main process. Preserving the live turn must not cost us that.
    listConversations.mockResolvedValue([
      persistedVersion(),
      { ...persistedVersion(), id: 'agent-run', title: 'Agent run' }
    ])

    await useChatStore.getState().refreshConversations()

    expect(
      useChatStore
        .getState()
        .conversations.map((c) => c.id)
        .sort()
    ).toEqual(['agent-run', 'c1'])
  })
})
