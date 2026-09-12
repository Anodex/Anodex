import { describe, expect, it, vi } from 'vitest'
import { REMOTE_CLIENT } from '@main/clients/clientRegistry'

/**
 * What a phone gets when it asks what has been archived.
 *
 * `listArchived` returns whole conversations, every message included. A renderer can
 * hold that — it is in the same process. A socket cannot: the bridge refuses any
 * frame over `MAX_RESPONSE_BYTES` with `response-too-large`, so on a store with any
 * real history the phone's archive screen failed outright rather than rendering
 * slowly. It showed "Could not read the archive from the computer" and nothing else.
 *
 * This is the same failure `forRemote` was written for on the tail read, reappearing
 * on the one other channel that hands back conversations in full.
 */
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    }
  }
}))

const archived = [
  {
    id: 'c_1',
    title: 'A long one',
    createdAt: 1,
    updatedAt: 2,
    projectId: null,
    archived: true,
    messages: Array.from({ length: 400 }, (_, i) => ({
      id: `m_${i}`,
      role: 'assistant',
      content: 'x'.repeat(5_000)
    }))
  }
]

vi.mock('@main/conversations/ConversationStore', () => ({
  conversationStore: {
    listArchived: () => archived,
    list: () => [],
    get: () => undefined,
    save: vi.fn(),
    delete: vi.fn()
  }
}))

const { registerConversationHandlers } = await import('../conversation.handlers')
registerConversationHandlers()

const listArchived = handlers.get('conversations:list-archived')!

describe('conversations:list-archived', () => {
  it('sends a phone summaries rather than transcripts', () => {
    const remote = { [REMOTE_CLIENT]: { id: 'remote:pixel', send: vi.fn(), isAlive: () => true } }

    const rows = listArchived(remote) as Array<Record<string, unknown>>

    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('c_1')
    expect(rows[0].title).toBe('A long one')
    // The whole point: the two megabytes of message bodies do not travel.
    expect(rows[0].messages).toBeUndefined()
  })

  it('is small enough to actually send', () => {
    // The bridge refuses over 4MB. The unnarrowed answer is comfortably past it,
    // which is why this failed as an error rather than as a slow screen.
    const remote = { [REMOTE_CLIENT]: { id: 'remote:pixel', send: vi.fn(), isAlive: () => true } }

    const forPhone = Buffer.byteLength(JSON.stringify(listArchived(remote)), 'utf8')
    const forWindow = Buffer.byteLength(JSON.stringify(listArchived({ sender: {} })), 'utf8')

    expect(forWindow).toBeGreaterThan(1_000_000)
    expect(forPhone).toBeLessThan(1_000)
  })

  it('still gives a window the whole thing', () => {
    // A renderer reads this in-process and does open what it lists, so narrowing it
    // there would be taking something away for no gain.
    const rows = listArchived({ sender: {} }) as Array<Record<string, unknown>>

    expect(rows[0].messages).toHaveLength(400)
  })
})
