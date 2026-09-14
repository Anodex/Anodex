import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@shared/conversation.types'

const listConversations = vi.hoisted(() => vi.fn<() => Promise<Conversation[]>>())
const getConversation = vi.hoisted(() => vi.fn<(id: string) => Promise<Conversation | null>>())
const listWithoutMessages = vi.hoisted(() => vi.fn<() => Promise<Conversation[]>>())
const saveConversation = vi.hoisted(() => vi.fn<(c: Conversation) => Promise<void>>())
const getConversationState = vi.hoisted(() =>
  vi.fn<() => Promise<{ activeConversationId: string | null }>>()
)

// `lib/anodex` dereferences `window.anodex` at import time — there is no
// window in the node test environment, so the preload bridge is stubbed out.
vi.mock('../../lib/anodex', () => ({
  anodex: {
    // Only the persistence calls the tested actions make; everything else on
    // the bridge stays absent so an unexpected call fails loudly.
    conversations: {
      save: saveConversation,
      setState: vi.fn().mockResolvedValue(undefined),
      deletePermanent: vi.fn().mockResolvedValue(undefined),
      list: listConversations,
      listWithoutMessages,
      get: getConversation,
      getState: getConversationState
    }
  }
}))

import {
  settleRunningToolCalls,
  useChatStore,
  withListFromDisk,
  withoutMessages,
  withReloaded
} from '../chatStore'

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

/**
 * What the computer has on disk, as the window now reads it: a listing without
 * messages, and each conversation whole when asked for.
 */
function onDisk(conversations: Conversation[]): void {
  listWithoutMessages.mockResolvedValue(conversations.map(withoutMessages))
  getConversation.mockImplementation((id) =>
    Promise.resolve(conversations.find((c) => c.id === id) ?? null)
  )
  getConversationState.mockResolvedValue({ activeConversationId: null })
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

  it('settles a provisional running card when the reply has ended', () => {
    const runningCall = {
      id: 't1',
      name: 'run_command',
      kind: 'command' as const,
      title: 'Run: Get-Content index.html',
      status: 'running' as const
    }
    const message = {
      toolCalls: [runningCall],
      blocks: [{ type: 'tool' as const, call: runningCall }]
    }

    settleRunningToolCalls(message)

    expect(message.toolCalls[0]).toMatchObject({
      status: 'error',
      madeProgress: false,
      detail: 'Reply ended before this tool reported completion'
    })
    expect(message.blocks[0].call.status).toBe('error')
  })

  it('ignores tokens for unknown conversations or messages without throwing', () => {
    useChatStore.getState().appendToken('nope', 'a1', 'x')
    useChatStore.getState().appendToken('c1', 'nope', 'x')
    expect(assistantMessage().content).toBe('partial reply')
  })

  it('applies a mixed frame in chronological order without merging across channels', () => {
    useChatStore.getState().applyStreamEventBatch('c1', 'a1', [
      { type: 'text', text: ' Let' },
      { type: 'thinking', text: ' the plan' },
      { type: 'text', text: ' me check' },
      {
        type: 'activity',
        calls: [
          { id: 't1', name: 'read_file', kind: 'read', title: 'Read foo.ts', status: 'success' }
        ]
      },
      { type: 'text', text: ' the files.' }
    ])

    expect(assistantMessage().blocks).toEqual([
      { type: 'text', text: 'partial reply Let' },
      { type: 'thinking', text: ' the plan' },
      { type: 'text', text: ' me check' },
      {
        type: 'tool',
        call: {
          id: 't1',
          name: 'read_file',
          kind: 'read',
          title: 'Read foo.ts',
          status: 'success'
        }
      },
      { type: 'text', text: ' the files.' }
    ])
  })

  it('drops late text but still keeps terminal tool status from a mixed frame', () => {
    useChatStore.setState({ conversations: [seedConversation(false)] })
    useChatStore.getState().applyStreamEventBatch('c1', 'a1', [
      { type: 'text', text: ' duplicate tail' },
      {
        type: 'activity',
        calls: [
          { id: 't1', name: 'read_file', kind: 'read', title: 'Read foo.ts', status: 'success' }
        ]
      }
    ])

    expect(assistantMessage().content).toBe('partial reply')
    expect(assistantMessage().toolCalls?.[0]?.status).toBe('success')
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
    listWithoutMessages.mockReset()
    getConversation.mockReset()
    useChatStore.setState({
      conversations: [seedConversation(true)],
      activeId: 'c1',
      loaded: true,
      pendingMessages: {}
    })
  })

  it('keeps the streaming turn instead of the truncated version on disk', async () => {
    onDisk([persistedVersion()])

    await useChatStore.getState().refreshConversations()

    const [conversation] = useChatStore.getState().conversations
    expect(conversation.messages.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(conversation.messages[1].streaming).toBe(true)
  })

  it('keeps a still-generating conversation that is absent from disk', async () => {
    onDisk([])

    await useChatStore.getState().refreshConversations()

    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['c1'])
  })

  it('takes the loaded version once nothing is streaming', async () => {
    useChatStore.setState({ conversations: [seedConversation(false)] })
    onDisk([{ ...persistedVersion(), title: 'Renamed elsewhere' }])

    await useChatStore.getState().refreshConversations()

    const [conversation] = useChatStore.getState().conversations
    expect(conversation.title).toBe('Renamed elsewhere')
    expect(conversation.messages).toHaveLength(0)
  })

  it('still picks up conversations created elsewhere while a turn streams', async () => {
    // The reason the refresh exists: an agent run writes its own conversation
    // in the main process. Preserving the live turn must not cost us that.
    onDisk([persistedVersion(), { ...persistedVersion(), id: 'agent-run', title: 'Agent run' }])

    await useChatStore.getState().refreshConversations()

    expect(
      useChatStore
        .getState()
        .conversations.map((c) => c.id)
        .sort()
    ).toEqual(['agent-run', 'c1'])
  })
})

describe('a background turn landing in the chat the user is mid-reply in', () => {
  /** The scheduled task's own chat, which the user also has open and is replying in. */
  function liveVersion(): Conversation {
    return {
      id: 'sched',
      projectId: null,
      title: 'Morning digest',
      createdAt: 1,
      updatedAt: 1,
      origin: 'scheduled',
      messages: [
        { id: 'u1', role: 'user', content: 'anything urgent?', createdAt: 2 },
        {
          id: 'a1',
          role: 'assistant',
          content: 'looking',
          createdAt: 3,
          streaming: true,
          blocks: [{ type: 'text', text: 'looking' }]
        }
      ]
    }
  }

  /** The same chat on disk, after the scheduled run appended its own turn. */
  function persistedWithBackgroundTurn(): Conversation {
    return {
      ...liveVersion(),
      messages: [
        { id: 'sched_u', role: 'user', content: 'Summarize new mail.', createdAt: 4 },
        { id: 'sched_a', role: 'assistant', content: 'Three new messages.', createdAt: 5 }
      ]
    }
  }

  beforeEach(() => {
    listConversations.mockReset()
    listWithoutMessages.mockReset()
    getConversation.mockReset()
    useChatStore.setState({
      conversations: [liveVersion()],
      activeId: 'sched',
      loaded: true,
      pendingMessages: {}
    })
  })

  it('keeps the background turn instead of losing it to the live copy', async () => {
    // Preserving the live copy whole is what protects a streaming reply, and it
    // is also how the scheduled run's turn used to disappear: the refresh skips
    // this conversation, so the live copy never learns about the new turn and
    // persists over it when the reply finishes.
    onDisk([persistedWithBackgroundTurn()])

    await useChatStore.getState().refreshConversations()

    const [conversation] = useChatStore.getState().conversations
    expect(conversation.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'sched_u', 'sched_a'])
  })

  it('does not disturb the reply still streaming into it', async () => {
    onDisk([persistedWithBackgroundTurn()])

    await useChatStore.getState().refreshConversations()

    const [conversation] = useChatStore.getState().conversations
    const streaming = conversation.messages.find((m) => m.id === 'a1')
    expect(streaming?.streaming).toBe(true)
    expect(streaming?.content).toBe('looking')
  })

  it('adds nothing when the persisted copy holds nothing new', async () => {
    // The ordinary case, and the one the previous behaviour got right: a
    // refresh mid-turn must not start duplicating the turn it is protecting.
    onDisk([{ ...liveVersion(), messages: [] }])

    await useChatStore.getState().refreshConversations()

    const [conversation] = useChatStore.getState().conversations
    expect(conversation.messages.map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('never resurrects a message the renderer deliberately dropped', async () => {
    // Edit-and-regenerate persists the truncated transcript first, then sends.
    // Those discarded turns are on disk for an instant; taking them back would
    // undo the edit.
    useChatStore.setState({ conversations: [{ ...liveVersion(), messages: [] }] })
    onDisk([persistedWithBackgroundTurn()])

    await useChatStore.getState().refreshConversations()

    // Nothing is streaming, so the loaded copy is authoritative — the merge
    // only ever applies to a conversation with a turn in flight.
    const [conversation] = useChatStore.getState().conversations
    expect(conversation.messages.map((m) => m.id)).toEqual(['sched_u', 'sched_a'])
  })
})

/**
 * A change announced for one conversation reads that conversation, not all of them.
 *
 * Reading every conversation — 48MB on the machine this was measured on — cost the
 * window most of a second of CPU for each phone reply, two or three times a reply.
 */
describe('reloading one conversation', () => {
  function chat(id: string, updatedAt: number, extra: Partial<Conversation> = {}): Conversation {
    return { id, projectId: null, title: id, createdAt: 1, updatedAt, messages: [], ...extra }
  }

  beforeEach(() => {
    listConversations.mockReset()
    listWithoutMessages.mockReset()
    getConversation.mockReset()
    getConversationState.mockReset()
    getConversationState.mockResolvedValue({ activeConversationId: null })
  })

  it('replaces the changed conversation and moves it to where its date puts it', () => {
    const current = [chat('a', 30), chat('b', 20), chat('c', 10)]
    const next = withReloaded(current, 'c', chat('c', 40, { title: 'Renamed' }))
    expect(next.map((c) => c.id)).toEqual(['c', 'a', 'b'])
    expect(next[0].title).toBe('Renamed')
  })

  it('adds a new conversation and removes one archived or gone', () => {
    const current = [chat('a', 30), chat('b', 20)]
    expect(withReloaded(current, 'n', chat('n', 25)).map((c) => c.id)).toEqual(['a', 'n', 'b'])
    expect(withReloaded(current, 'b', chat('b', 50, { archived: true })).map((c) => c.id)).toEqual([
      'a'
    ])
    expect(withReloaded(current, 'b', null).map((c) => c.id)).toEqual(['a'])
  })

  it('never takes a generating conversation from under its reply', () => {
    const live = seedConversation(true)
    const onDisk = { ...live, messages: [], updatedAt: 99 }
    expect(withReloaded([live], 'c1', onDisk)[0].messages.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(withReloaded([live], 'c1', null)).toHaveLength(1)
  })

  it('reads only the named conversation, never the whole list', async () => {
    useChatStore.setState({
      conversations: [chat('a', 30), chat('b', 20)],
      activeId: 'a',
      loaded: true,
      pendingMessages: {}
    })
    getConversation.mockResolvedValue(chat('b', 40, { title: 'From the phone' }))

    await useChatStore.getState().reloadConversations(['b'])

    expect(listConversations).not.toHaveBeenCalled()
    expect(getConversation).toHaveBeenCalledWith('b')
    expect(useChatStore.getState().conversations.map((c) => c.title)).toEqual([
      'From the phone',
      'a'
    ])
    expect(useChatStore.getState().activeId).toBe('a')
  })

  it('follows the computer when the open conversation was archived elsewhere', async () => {
    useChatStore.setState({
      conversations: [chat('a', 30)],
      activeId: 'a',
      loaded: true,
      pendingMessages: {}
    })
    getConversation.mockResolvedValue(chat('a', 40, { archived: true }))

    await useChatStore.getState().reloadConversations(['a'])

    expect(useChatStore.getState().conversations).toEqual([])
    expect(useChatStore.getState().activeId).toBeNull()
  })

  it('reads the list, as before, when reading the one fails', async () => {
    useChatStore.setState({
      conversations: [chat('a', 30)],
      activeId: null,
      loaded: true,
      pendingMessages: {}
    })
    getConversation.mockRejectedValue(new Error('gone away'))
    listWithoutMessages.mockResolvedValue([chat('a', 30), chat('z', 5)].map(withoutMessages))

    await useChatStore.getState().reloadConversations(['a'])

    // Once: the reread the list asks for fails too, and must not ask for the list again.
    expect(listWithoutMessages).toHaveBeenCalledOnce()
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['a', 'z'])
  })
})

/**
 * The window lists conversations without their messages and reads one when it is
 * needed. What that must never do is lose a message: save a conversation it never
 * read, show an empty chat where there is history, or send a turn without it.
 */
describe('conversations read when they are needed', () => {
  function whole(id: string, updatedAt = 10): Conversation {
    return {
      id,
      projectId: null,
      title: id,
      createdAt: 1,
      updatedAt,
      messages: [
        { id: `${id}-u`, role: 'user', content: 'question', createdAt: 1 },
        { id: `${id}-a`, role: 'assistant', content: 'answer', createdAt: 2 }
      ]
    }
  }

  beforeEach(() => {
    listConversations.mockReset()
    getConversation.mockReset()
    getConversationState.mockReset()
    listWithoutMessages.mockReset()
    saveConversation.mockReset()
    saveConversation.mockResolvedValue(undefined)
    getConversationState.mockResolvedValue({ activeConversationId: null })
    useChatStore.setState({ conversations: [], activeId: null, loaded: true, pendingMessages: {} })
  })

  it('lists without messages, and reads the open conversation whole', async () => {
    listWithoutMessages.mockResolvedValue([
      withoutMessages(whole('a')),
      withoutMessages(whole('b'))
    ])
    getConversationState.mockResolvedValue({ activeConversationId: 'b' })
    getConversation.mockImplementation((id) => Promise.resolve(whole(id)))

    await useChatStore.getState().load()
    await vi.waitFor(() =>
      expect(
        useChatStore.getState().conversations.find((c) => c.id === 'b')?.messagesNotLoaded
      ).toBeUndefined()
    )

    const [a, b] = useChatStore.getState().conversations
    expect(listConversations).not.toHaveBeenCalled()
    expect(a.messagesNotLoaded).toBe(true)
    expect(b.messages).toHaveLength(2)
    expect(getConversation).toHaveBeenCalledTimes(1)
  })

  it('reads a conversation when it is chosen', async () => {
    useChatStore.setState({ conversations: [withoutMessages(whole('a'))] })
    getConversation.mockResolvedValue(whole('a'))

    await useChatStore.getState().selectConversation('a')
    await vi.waitFor(() =>
      expect(useChatStore.getState().conversations[0].messages).toHaveLength(2)
    )
  })

  it('renames a conversation it never read without writing it back empty', async () => {
    useChatStore.setState({ conversations: [withoutMessages(whole('a'))] })
    getConversation.mockResolvedValue(whole('a'))

    await useChatStore.getState().renameConversation('a', 'Better name')

    const saved = saveConversation.mock.calls[0][0]
    expect(saved.title).toBe('Better name')
    expect(saved.messages).toHaveLength(2)
    expect(saved.messagesNotLoaded).toBeUndefined()
  })

  it('keeps the messages of every conversation already read, and rereads each', () => {
    useChatStore.setState({
      conversations: [whole('a', 10), whole('b', 10), withoutMessages(whole('c'))]
    })

    const { conversations, stale } = withListFromDisk(useChatStore.getState().conversations, [
      withoutMessages(whole('a', 10)),
      withoutMessages(whole('b', 20)),
      withoutMessages(whole('c', 30))
    ])

    expect(conversations.find((c) => c.id === 'a')?.messages).toHaveLength(2)
    expect(conversations.find((c) => c.id === 'b')?.messages).toHaveLength(2)
    expect(stale).toEqual(['a', 'b'])
    expect(conversations.find((c) => c.id === 'c')?.updatedAt).toBe(30)
  })

  it('reads a conversation before sending into it, so the turn carries its history', async () => {
    useChatStore.setState({ conversations: [withoutMessages(whole('a'))], activeId: null })
    getConversation.mockResolvedValue(whole('a'))

    const loaded = await useChatStore.getState().ensureConversationLoaded('a')

    expect(loaded?.messages.map((m) => m.id)).toEqual(['a-u', 'a-a'])
  })

  it('never discards an email chat it has not read as though it were unused', () => {
    useChatStore.setState({
      conversations: [
        { ...withoutMessages(whole('mail')), emailThread: { accountId: 'x', threadId: 't' } }
      ],
      pendingComposerText: null
    })

    useChatStore.getState().discardUnusedEmailThreadConversation('mail')

    expect(useChatStore.getState().conversations).toHaveLength(1)
  })

  it('refuses to edit or regenerate in a conversation whose messages are not read', async () => {
    useChatStore.setState({ conversations: [withoutMessages(whole('a'))], activeId: 'x' })
    useChatStore.setState({ activeId: 'a' })
    expect((await useChatStore.getState().editMessage('a-u', 'changed')).status).toBe('failed')
    expect((await useChatStore.getState().regenerateMessage('a-a')).status).toBe('failed')
  })

  it('keeps a conversation it has not read out of memory when a change is announced', async () => {
    useChatStore.setState({
      conversations: [withoutMessages(whole('a')), whole('b')],
      activeId: 'b'
    })
    getConversation.mockImplementation((id) => Promise.resolve(whole(id, 50)))

    await useChatStore.getState().reloadConversations(['a', 'b'])

    const byId = new Map(useChatStore.getState().conversations.map((c) => [c.id, c]))
    expect(byId.get('a')?.messagesNotLoaded).toBe(true)
    expect(byId.get('a')?.updatedAt).toBe(50)
    expect(byId.get('b')?.messages).toHaveLength(2)
  })

  it('records a checkpoint undone from the panel on a conversation it had not read', async () => {
    useChatStore.setState({ conversations: [withoutMessages(whole('a'))], activeId: null })
    getConversation.mockResolvedValue(whole('a'))
    const checkpoint = { id: 'cp', changedFiles: ['x.ts'], restored: true } as never

    useChatStore.getState().syncCheckpointSummary('a', 'a-a', checkpoint)

    await vi.waitFor(() => expect(saveConversation).toHaveBeenCalled())
    const saved = saveConversation.mock.calls[0][0]
    expect(saved.messages.find((m) => m.id === 'a-a')?.checkpoint).toEqual(checkpoint)
    expect(saved.messages).toHaveLength(2)
  })
})
