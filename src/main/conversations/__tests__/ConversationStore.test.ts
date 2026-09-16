import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INTERRUPTED_GENERATION_MESSAGE } from '@shared/chatSanitizer'
import type { Conversation } from '@shared/conversation.types'

const h = vi.hoisted(() => ({
  /** When set, any write whose path contains this fragment throws. */
  failWritePattern: null as string | null,
  warn: vi.fn(),
  abortGeneration: vi.fn()
}))

let userDataDir = ''
const tempDirs: string[] = []

vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }))

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ warn: h.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('../../chat/inflightGenerations', () => ({ abortGeneration: h.abortGeneration }))

vi.mock('../ConversationAssetStore', () => ({
  conversationAssetStore: {
    init: vi.fn(),
    removeConversation: vi.fn(),
    pruneConversation: vi.fn()
  }
}))

// Real filesystem, except that writes to a chosen path can be made to fail on
// demand — the only way to exercise the store's failure ordering.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: ((path: Parameters<typeof actual.writeFileSync>[0], ...rest: unknown[]) => {
      if (h.failWritePattern !== null && String(path).includes(h.failWritePattern)) {
        throw new Error(`simulated write failure: ${String(path)}`)
      }
      return (actual.writeFileSync as (...args: unknown[]) => void)(path, ...rest)
    }) as typeof actual.writeFileSync
  }
})

const { conversationStore } = await import('../ConversationStore')

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anodex-conversations-'))
  tempDirs.push(dir)
  return dir
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'chat-1',
    projectId: null,
    title: 'Test chat',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

const filePathFor = (dir: string, id: string): string =>
  join(userDataDir, 'conversations', dir, `${id}.json`)

beforeEach(() => {
  userDataDir = makeTempDir()
  h.failWritePattern = null
  h.warn.mockClear()
  h.abortGeneration.mockClear()
  conversationStore.init()
})

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('ConversationStore path safety', () => {
  it('rejects ids that would escape the conversations directory', () => {
    expect(() => conversationStore.save(conversation({ id: '../escape' }))).toThrow(
      /Unsafe conversation id/
    )
    expect(() => conversationStore.save(conversation({ projectId: '../escape' }))).toThrow(
      /Unsafe project id/
    )
    expect(() => conversationStore.archive('..')).toThrow(/Unsafe conversation id/)
    expect(() => conversationStore.deletePermanent('nested/id')).toThrow(/Unsafe conversation id/)
    expect(() => conversationStore.archiveByProject('../escape')).toThrow(/Unsafe project id/)
  })
})

describe('ConversationStore remote saves', () => {
  // A paired phone reads a conversation through `conversations:get`, which answers
  // with the last N turns because a long transcript cannot be buffered over a
  // socket. It then saves what it is holding. Written straight to disk that is not
  // an update, it is a deletion of everything the phone could not see — which is
  // what happened to a real conversation: continued once from the phone, found
  // afterwards holding two messages and its original createdAt.
  const turn = (id: string, content = 'x'): Conversation['messages'][number] =>
    ({ id, role: 'user', content }) as Conversation['messages'][number]

  it('keeps the turns a remote client never saw', () => {
    conversationStore.save(
      conversation({ messages: [turn('a'), turn('b'), turn('c')], createdAt: 100 })
    )

    // The tail, plus one new turn — exactly the shape the phone sends back.
    conversationStore.save(
      conversation({ messages: [turn('c'), turn('d')], createdAt: 999, updatedAt: 5 }),
      { fromRemote: true }
    )

    const stored = conversationStore.get('chat-1')
    expect(stored?.messages.map((message) => message.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(stored?.updatedAt).toBe(5)
  })

  it('keeps everything when a remote client saves an empty transcript', () => {
    // The sharp case. A failed read on the phone becomes an empty conversation
    // bound to a real id, and the first message then saves one turn over the lot.
    conversationStore.save(conversation({ messages: [turn('a'), turn('b')] }))
    conversationStore.save(conversation({ messages: [turn('new')] }), { fromRemote: true })

    expect(conversationStore.get('chat-1')?.messages.map((m) => m.id)).toEqual(['a', 'b', 'new'])
  })

  it('takes the title a remote client sends, but not a different project', () => {
    // A rename from the phone is real. A project is not: the phone cannot move a chat,
    // and builds before 0.71.1 sent the computer's open project for every plain chat
    // they opened — which refiled the chat and put its turns in that project's files.
    conversationStore.save(conversation({ messages: [turn('a')], title: 'Old', projectId: null }))
    conversationStore.save(
      conversation({ messages: [turn('a')], title: 'New', projectId: 'proj1' }),
      { fromRemote: true }
    )

    const stored = conversationStore.get('chat-1')
    expect(stored?.title).toBe('New')
    expect(stored?.projectId).toBeNull()
  })

  it('still files a conversation it has never seen where the phone says', () => {
    // A chat started from the phone's Workspace screen is created in that project.
    conversationStore.save(conversation({ messages: [turn('a')], projectId: 'proj1' }), {
      fromRemote: true
    })

    expect(conversationStore.get('chat-1')?.projectId).toBe('proj1')
  })

  it('keeps the stored copy of a turn both sides wrote, filling only what it lacked', () => {
    // The computer records a phone's turn when it finishes, and the phone's own save
    // lands after it. Only the phone knows who answered; the stored reply text wins.
    conversationStore.save(
      conversation({
        messages: [{ ...turn('m1:reply', 'from the computer'), role: 'assistant' }]
      })
    )
    conversationStore.save(
      conversation({
        messages: [
          {
            ...turn('m1:reply', 'from the phone'),
            role: 'assistant',
            persona: { id: 'builtin:direct', name: 'Vale', tint: 'accent' }
          }
        ]
      }),
      { fromRemote: true }
    )

    const [reply] = conversationStore.get('chat-1')?.messages ?? []
    expect(reply.content).toBe('from the computer')
    expect(reply.persona?.name).toBe('Vale')
  })

  it('keeps the original createdAt, which a partial client cannot know', () => {
    conversationStore.save(conversation({ messages: [turn('a')], createdAt: 100 }))
    conversationStore.save(conversation({ messages: [turn('a')], createdAt: 999 }), {
      fromRemote: true
    })

    expect(conversationStore.get('chat-1')?.createdAt).toBe(100)
  })

  it('does not let a remote save resurrect an archived conversation', () => {
    conversationStore.save(conversation({ messages: [turn('a')] }))
    conversationStore.archive('chat-1')

    conversationStore.save(conversation({ messages: [turn('b')] }), { fromRemote: true })

    expect(conversationStore.get('chat-1')?.archived).toBe(true)
  })

  it('still replaces wholesale for a local save, which can legitimately delete', () => {
    // The desktop can edit and delete individual turns. Merging its writes would
    // make deleting a message impossible.
    conversationStore.save(conversation({ messages: [turn('a'), turn('b')] }))
    conversationStore.save(conversation({ messages: [turn('a')] }))

    expect(conversationStore.get('chat-1')?.messages.map((m) => m.id)).toEqual(['a'])
  })

  it('writes a remote save for a conversation it has never seen', () => {
    // A chat started on the phone. There is nothing to merge onto, and refusing it
    // would mean the phone could not start a conversation at all.
    conversationStore.save(conversation({ id: 'from-phone', messages: [turn('a')] }), {
      fromRemote: true
    })

    expect(conversationStore.get('from-phone')?.messages.map((m) => m.id)).toEqual(['a'])
  })
})

describe('ConversationStore persistence', () => {
  it('moves the file when a conversation changes project, leaving no duplicate', () => {
    conversationStore.save(conversation())
    expect(existsSync(filePathFor('general', 'chat-1'))).toBe(true)

    conversationStore.save(conversation({ projectId: 'proj1' }))

    expect(existsSync(filePathFor('general', 'chat-1'))).toBe(false)
    expect(existsSync(filePathFor('proj1', 'chat-1'))).toBe(true)
    expect(conversationStore.listShallow()).toHaveLength(1)
  })

  it('keeps the original file when the write for a project move fails', () => {
    conversationStore.save(conversation())

    h.failWritePattern = join('conversations', 'proj1')
    expect(() => conversationStore.save(conversation({ projectId: 'proj1' }))).toThrow(
      /simulated write failure/
    )
    h.failWritePattern = null

    // The conversation must survive: removing the old file before the new one
    // is safely written would have destroyed it outright.
    expect(existsSync(filePathFor('general', 'chat-1'))).toBe(true)
    expect(conversationStore.listShallow().map((row) => row.conversation.id)).toEqual(['chat-1'])
  })

  it('does not cache conversation state that failed to persist', () => {
    conversationStore.setState({ activeConversationId: 'chat-1' })

    h.failWritePattern = 'state.json'
    expect(() => conversationStore.setState({ activeConversationId: 'chat-2' })).toThrow(
      /simulated write failure/
    )
    h.failWritePattern = null

    expect(conversationStore.getState().activeConversationId).toBe('chat-1')
  })

  it('skips unreadable conversation files instead of dropping them silently', () => {
    conversationStore.save(conversation({ id: 'good' }))
    const dir = join(userDataDir, 'conversations', 'general')
    writeFileSync(join(dir, 'malformed.json'), '{ not json', 'utf-8')
    writeFileSync(join(dir, 'null.json'), 'null', 'utf-8')
    writeFileSync(join(dir, 'shapeless.json'), '{}', 'utf-8')
    // Parses, and survives the sanitizer, but has no id — without a shape check
    // this lands in the cache under the key `undefined` and shows up in the
    // sidebar as a conversation that can never be opened.
    writeFileSync(join(dir, 'idless.json'), '{"messages":[],"title":"no id"}', 'utf-8')

    conversationStore.init()

    expect(conversationStore.listShallow().map((row) => row.conversation.id)).toEqual(['good'])
    expect(h.warn).toHaveBeenCalledTimes(4)
  })

  it('clears cached state when re-initialised against a different directory', () => {
    conversationStore.setState({ activeConversationId: 'chat-1' })

    userDataDir = makeTempDir()
    conversationStore.init()

    expect(conversationStore.getState().activeConversationId).toBeNull()
  })

  it('settles a reply left streaming when the previous app session closed', () => {
    conversationStore.save(
      conversation({
        messages: [
          { id: 'u1', role: 'user', content: 'Continue.', createdAt: 1 },
          {
            id: 'a1',
            role: 'assistant',
            content: 'Partial reply',
            createdAt: 2,
            streaming: true,
            toolCalls: [
              {
                id: 'tool-1',
                name: 'read_file',
                kind: 'read',
                title: 'Read app.ts',
                status: 'running'
              }
            ],
            blocks: [
              {
                type: 'tool',
                call: {
                  id: 'tool-1',
                  name: 'read_file',
                  kind: 'read',
                  title: 'Read app.ts',
                  status: 'running'
                }
              }
            ]
          }
        ]
      })
    )

    conversationStore.init()

    const message = conversationStore.listShallow()[0].conversation.messages[1]
    expect(message.streaming).toBe(false)
    expect(message.error).toBe(INTERRUPTED_GENERATION_MESSAGE)
    expect(message.toolCalls?.[0]).toMatchObject({
      status: 'error',
      detail: 'Interrupted when Anodex closed.'
    })
    expect(message.blocks?.[0]).toMatchObject({
      type: 'tool',
      call: { status: 'error', detail: 'Interrupted when Anodex closed.' }
    })
  })
})

describe('ConversationStore holding archived conversations', () => {
  function withMessages(id: string, count: number): Conversation {
    return conversation({
      id,
      messages: Array.from({ length: count }, (_, i) => ({
        id: `${id}-m${i}`,
        role: 'user' as const,
        content: `message ${i}`,
        createdAt: 1
      }))
    })
  }

  /** A fresh store reading what is on disk, as at launch. */
  function relaunch(): void {
    conversationStore.init()
  }

  it("leaves an archived conversation's messages on disk until they are asked for", () => {
    conversationStore.save(withMessages('old', 3))
    conversationStore.archive('old')
    relaunch()

    const [listed] = conversationStore.listArchivedWithoutMessages()
    expect(listed.conversation.messages).toEqual([])
    expect(listed.messageCount).toBe(3)

    // Every read that promises a conversation still gets all of it.
    expect(conversationStore.get('old')?.messages).toHaveLength(3)
    expect(
      conversationStore.searchable(new Set(['old']), { archived: true })[0].messages
    ).toHaveLength(3)
  })

  it('restores an archived conversation with every message', () => {
    conversationStore.save(withMessages('old', 4))
    conversationStore.archive('old')
    relaunch()

    conversationStore.restore('old')
    relaunch()

    expect(conversationStore.get('old')?.messages.map((m) => m.id)).toEqual([
      'old-m0',
      'old-m1',
      'old-m2',
      'old-m3'
    ])
  })

  it('refuses to restore one it cannot read, rather than writing it back empty', () => {
    conversationStore.save(withMessages('old', 2))
    conversationStore.archive('old')
    relaunch()
    conversationStore.listArchivedWithoutMessages()
    const file = join(userDataDir, 'conversations', 'general', 'old.json')
    writeFileSync(file, 'not json', 'utf-8')

    expect(() => conversationStore.restore('old')).toThrow(/Could not read conversation/)
  })

  it('merges a remote save into an archived conversation without losing its messages', () => {
    conversationStore.save(withMessages('old', 2))
    conversationStore.archive('old')
    relaunch()

    conversationStore.save(withMessages('old', 0), { fromRemote: true })

    expect(conversationStore.get('old')?.messages).toHaveLength(2)
  })
})

/**
 * The same reasoning as the archive, applied to chats nobody has opened in weeks:
 * measured, 102 live chats were 48MB of JSON held for the life of the app while the
 * sidebar shows only their titles.
 */
describe('ConversationStore holding only recent chats', () => {
  function chatAt(id: string, updatedAt: number): Conversation {
    return conversation({
      id,
      updatedAt,
      messages: [{ id: `${id}-m0`, role: 'user', content: 'a message', createdAt: 1 }]
    })
  }

  function saveMany(count: number): void {
    for (let index = 0; index < count; index++) {
      conversationStore.save(chatAt(`chat-${index}`, 1000 + index))
    }
    conversationStore.init()
  }

  it('lists every chat without reading an old one, and says how long each is', () => {
    saveMany(30)

    const shallow = conversationStore.listShallow()

    expect(shallow).toHaveLength(30)
    expect(shallow[0].conversation.id).toBe('chat-29')
    // Newest first: the recent ones keep their messages, the oldest do not.
    expect(shallow[0].conversation.messages).toHaveLength(1)
    expect(shallow[29].conversation.messages).toEqual([])
    // Length is known either way, which is all a list shows.
    expect(shallow[29].messageCount).toBe(1)
  })

  it('reads an old chat whole when something actually asks for it', () => {
    saveMany(30)

    expect(conversationStore.get('chat-0')?.messages).toHaveLength(1)
    expect(
      conversationStore
        .searchable(new Set(['message']), { archived: false })
        .find((c) => c.id === 'chat-0')?.messages
    ).toHaveLength(1)
  })

  it('holds a chat it saves, so a conversation in use is never read per turn', () => {
    saveMany(30)
    conversationStore.save(chatAt('chat-0', 9999))

    // Saved, so it is current again: no disk read behind this.
    expect(
      conversationStore.listShallow().find((row) => row.conversation.id === 'chat-0')?.conversation
        .messages
    ).toHaveLength(1)
  })
})

describe('ConversationStore searching without loading every chat', () => {
  function chatSaying(id: string, updatedAt: number, said: string): Conversation {
    return conversation({
      id,
      updatedAt,
      messages: [{ id: `${id}-m0`, role: 'user', content: said, createdAt: 1 }]
    })
  }

  /** 30 old chats about nothing, one of which mentions marzipan. */
  function fillStore(): void {
    for (let index = 0; index < 30; index++) {
      conversationStore.save(
        chatSaying(`chat-${index}`, 1000 + index, index === 0 ? 'the marzipan recipe' : 'a message')
      )
    }
    conversationStore.init()
  }

  it('opens an old chat that could match, and leaves the rest on disk', () => {
    fillStore()

    const found = conversationStore.searchable(new Set(['marzipan']), { archived: false })

    expect(found.map((chat) => chat.id)).toContain('chat-0')
    expect(found.find((chat) => chat.id === 'chat-0')?.messages).toHaveLength(1)
    // Every chat is a candidate the caller scores, but only the recent ones — held
    // anyway — and the one that could match were read.
    expect(found.filter((chat) => chat.messages.length > 0)).toHaveLength(26)
  })

  it('reads nothing at all for a word no chat has', () => {
    fillStore()
    const heldBefore = conversationStore.heldConversationFiles().length

    const found = conversationStore.searchable(new Set(['sasquatch']), { archived: false })

    expect(found.every((chat) => chat.id !== 'chat-0')).toBe(true)
    expect(conversationStore.heldConversationFiles()).toHaveLength(heldBefore)
  })

  it('lets go of what it read, so searching does not refill memory', () => {
    fillStore()
    const heldBefore = conversationStore.heldConversationFiles().length

    conversationStore.searchable(new Set(['marzipan']), { archived: false })

    expect(conversationStore.heldConversationFiles()).toHaveLength(heldBefore)
  })

  it('narrows by what a list already knows before reading anything', () => {
    fillStore()
    conversationStore.save({ ...chatSaying('other', 900, 'the marzipan recipe'), projectId: 'p1' })
    conversationStore.init()

    const found = conversationStore.searchable(new Set(['marzipan']), {
      archived: false,
      matching: (chat) => chat.projectId === 'p1'
    })

    expect(found.map((chat) => chat.id)).toEqual(['other'])
  })
})

describe('ConversationStore archiving', () => {
  it('moves conversations between the active and archived lists', () => {
    conversationStore.save(conversation({ id: 'chat-1' }))
    conversationStore.setState({ activeConversationId: 'chat-1' })

    conversationStore.archive('chat-1')

    expect(conversationStore.listShallow()).toHaveLength(0)
    expect(
      conversationStore.listArchivedWithoutMessages().map((row) => row.conversation.id)
    ).toEqual(['chat-1'])
    expect(conversationStore.getState().activeConversationId).toBeNull()
    expect(h.abortGeneration).toHaveBeenCalledWith('chat-1')

    conversationStore.restore('chat-1')

    const [restored] = conversationStore.listShallow()
    expect(restored.conversation.id).toBe('chat-1')
    expect(restored.conversation.archived).toBe(false)
    expect(restored.conversation.archivedAt).toBeUndefined()
    expect(conversationStore.listArchivedWithoutMessages()).toHaveLength(0)
  })

  it('stamps archivedAt and updatedAt with a single instant', () => {
    conversationStore.save(conversation({ id: 'chat-1' }))
    conversationStore.archive('chat-1')

    const [archived] = conversationStore.listArchivedWithoutMessages()
    expect(archived.conversation.archivedAt).toBe(archived.conversation.updatedAt)
  })

  it('refuses to permanently delete conversations that are not archived', () => {
    conversationStore.save(conversation({ id: 'live' }))
    conversationStore.save(conversation({ id: 'old' }))
    conversationStore.archive('old')

    conversationStore.deleteArchived(['old', 'live'])

    expect(conversationStore.listShallow().map((row) => row.conversation.id)).toEqual(['live'])
    expect(conversationStore.listArchivedWithoutMessages()).toHaveLength(0)
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('not archived'), 'live')
  })
})

describe('ConversationStore project deletion', () => {
  it('clears the active conversation when its project is permanently deleted', () => {
    conversationStore.save(conversation({ id: 'chat-1', projectId: 'proj1' }))
    conversationStore.setState({ activeConversationId: 'chat-1' })

    conversationStore.deleteByProjectPermanent('proj1')

    expect(conversationStore.getState().activeConversationId).toBeNull()
    expect(conversationStore.listShallow()).toHaveLength(0)
    expect(h.abortGeneration).toHaveBeenCalledWith('chat-1')
  })

  it('leaves conversations in other projects untouched', () => {
    conversationStore.save(conversation({ id: 'keep', projectId: 'proj2' }))
    conversationStore.save(conversation({ id: 'drop', projectId: 'proj1' }))

    conversationStore.deleteByProjectPermanent('proj1')

    expect(conversationStore.listShallow().map((row) => row.conversation.id)).toEqual(['keep'])
    expect(existsSync(filePathFor('proj2', 'keep'))).toBe(true)
  })
})
