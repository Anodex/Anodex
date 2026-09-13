import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '@shared/ipc'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  broadcastToOtherClients: vi.fn(),
  store: { delete: vi.fn(), restore: vi.fn(), deletePermanent: vi.fn() }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock('../../broadcast', () => ({ broadcastToOtherClients: mocks.broadcastToOtherClients }))
vi.mock('../../clients/clientRegistry', () => ({
  isRemoteCall: () => true,
  resolveClientChannel: () => ({ id: 'phone' })
}))
vi.mock('../../conversations/ConversationStore', () => ({ conversationStore: mocks.store }))
vi.mock('../../conversations/ConversationAssetStore', () => ({ conversationAssetStore: {} }))
vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

import { registerConversationHandlers } from '../conversation.handlers'

/**
 * A conversation archived, restored or deleted on one device is announced to the others.
 *
 * Seen on this machine: chats archived from the phone stayed in the desktop's sidebar,
 * because only saves were announced.
 */
describe('conversation change announcements', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.broadcastToOtherClients.mockReset()
    registerConversationHandlers()
  })

  it.each([
    ['archive', IpcChannel.Conversations.delete],
    ['restore', IpcChannel.Conversations.restore],
    ['permanent delete', IpcChannel.Conversations.deletePermanent]
  ])('announces a %s to every other client', (_name, channel) => {
    mocks.handlers.get(channel)?.({}, 'chat-1')

    expect(mocks.broadcastToOtherClients).toHaveBeenCalledWith(
      { id: 'phone' },
      IpcChannel.Conversations.changed,
      'chat-1'
    )
  })

  it('announces nothing when the store refused', () => {
    mocks.store.delete.mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    expect(() => mocks.handlers.get(IpcChannel.Conversations.delete)?.({}, 'chat-1')).toThrow()
    expect(mocks.broadcastToOtherClients).not.toHaveBeenCalled()
  })
})
