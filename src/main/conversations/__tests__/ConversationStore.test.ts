import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('ConversationStore persistence', () => {
  it('moves the file when a conversation changes project, leaving no duplicate', () => {
    conversationStore.save(conversation())
    expect(existsSync(filePathFor('general', 'chat-1'))).toBe(true)

    conversationStore.save(conversation({ projectId: 'proj1' }))

    expect(existsSync(filePathFor('general', 'chat-1'))).toBe(false)
    expect(existsSync(filePathFor('proj1', 'chat-1'))).toBe(true)
    expect(conversationStore.list()).toHaveLength(1)
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
    expect(conversationStore.list().map((entry) => entry.id)).toEqual(['chat-1'])
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

    expect(conversationStore.list().map((entry) => entry.id)).toEqual(['good'])
    expect(h.warn).toHaveBeenCalledTimes(4)
  })

  it('clears cached state when re-initialised against a different directory', () => {
    conversationStore.setState({ activeConversationId: 'chat-1' })

    userDataDir = makeTempDir()
    conversationStore.init()

    expect(conversationStore.getState().activeConversationId).toBeNull()
  })
})

describe('ConversationStore archiving', () => {
  it('moves conversations between the active and archived lists', () => {
    conversationStore.save(conversation({ id: 'chat-1' }))
    conversationStore.setState({ activeConversationId: 'chat-1' })

    conversationStore.archive('chat-1')

    expect(conversationStore.list()).toHaveLength(0)
    expect(conversationStore.listArchived().map((entry) => entry.id)).toEqual(['chat-1'])
    expect(conversationStore.getState().activeConversationId).toBeNull()
    expect(h.abortGeneration).toHaveBeenCalledWith('chat-1')

    conversationStore.restore('chat-1')

    const [restored] = conversationStore.list()
    expect(restored.id).toBe('chat-1')
    expect(restored.archived).toBe(false)
    expect(restored.archivedAt).toBeUndefined()
    expect(conversationStore.listArchived()).toHaveLength(0)
  })

  it('stamps archivedAt and updatedAt with a single instant', () => {
    conversationStore.save(conversation({ id: 'chat-1' }))
    conversationStore.archive('chat-1')

    const [archived] = conversationStore.listArchived()
    expect(archived.archivedAt).toBe(archived.updatedAt)
  })

  it('refuses to permanently delete conversations that are not archived', () => {
    conversationStore.save(conversation({ id: 'live' }))
    conversationStore.save(conversation({ id: 'old' }))
    conversationStore.archive('old')

    conversationStore.deleteArchived(['old', 'live'])

    expect(conversationStore.list().map((entry) => entry.id)).toEqual(['live'])
    expect(conversationStore.listArchived()).toHaveLength(0)
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('not archived'), 'live')
  })
})

describe('ConversationStore project deletion', () => {
  it('clears the active conversation when its project is permanently deleted', () => {
    conversationStore.save(conversation({ id: 'chat-1', projectId: 'proj1' }))
    conversationStore.setState({ activeConversationId: 'chat-1' })

    conversationStore.deleteByProjectPermanent('proj1')

    expect(conversationStore.getState().activeConversationId).toBeNull()
    expect(conversationStore.listAll()).toHaveLength(0)
    expect(h.abortGeneration).toHaveBeenCalledWith('chat-1')
  })

  it('leaves conversations in other projects untouched', () => {
    conversationStore.save(conversation({ id: 'keep', projectId: 'proj2' }))
    conversationStore.save(conversation({ id: 'drop', projectId: 'proj1' }))

    conversationStore.deleteByProjectPermanent('proj1')

    expect(conversationStore.listAll().map((entry) => entry.id)).toEqual(['keep'])
    expect(existsSync(filePathFor('proj2', 'keep'))).toBe(true)
  })
})
