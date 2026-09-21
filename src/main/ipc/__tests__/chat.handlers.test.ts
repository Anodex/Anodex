import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '@shared/ipc'
import type { ChatRequest } from '@shared/chat.types'
import { registerChatHandlers } from '../chat.handlers'
import { REMOTE_CLIENT } from '../../clients/clientRegistry'

type IpcTestHandler = (event: unknown, request: unknown) => unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcTestHandler>(),
  generate: vi.fn(),
  recordSummary: vi.fn(),
  recordGeneration: vi.fn(),
  saveConversation: vi.fn<(...args: unknown[]) => void>()
}))

vi.mock('../../conversations/ConversationStore', () => ({
  conversationStore: {
    get: () => undefined,
    save: (...args: unknown[]) => mocks.saveConversation(...args)
  }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcTestHandler) => {
      mocks.handlers.set(channel, handler)
    })
  }
}))

vi.mock('../../llm/ProviderRegistry', () => ({
  getActiveProvider: () => ({ generate: mocks.generate })
}))

vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: {
    get: () => ({
      tools: { enabled: false },
      general: { permissionMode: 'ask', defaultShell: '' },
      git: { attributeCommits: true, attributionEmail: 'anodex@anodex.dev' },
      webSearch: { provider: 'duckduckgo', requireApproval: false },
      memory: { crossChatEnabled: false, personalEnabled: false },
      transcriptRecall: {
        enabled: false,
        crossScopeEnabled: false,
        archivedEnabled: false,
        cloudProviderEnabled: false
      },
      assistantStyle: { globalStyle: '', personalities: [], activePersonalityId: null },
      generation: { temperature: 0.7, topP: 0.9, maxTokens: 512 },
      provider: { active: 'local', anthropic: { apiKey: '', model: 'claude-sonnet-5' } }
    })
  }
}))

vi.mock('../../projects/ProjectStore', () => ({
  projectStore: {
    getState: () => ({ activeProjectId: null, projects: [] })
  }
}))

vi.mock('../../projects/ProjectMemoryStore', () => ({
  projectMemoryStore: { recordSummary: mocks.recordSummary }
}))

vi.mock('../../stats/TokenActivityStore', () => ({
  tokenActivityStore: { recordGeneration: mocks.recordGeneration }
}))

vi.mock('../../llama/LlamaService', () => ({
  llamaService: {
    getState: () => ({ model: null }),
    countPromptTokens: () => 0,
    compactConversationContext: vi.fn(),
    summarizeForToast: vi.fn(),
    generateChatTitle: vi.fn(),
    hasQueuedModelWork: () => false
  }
}))

vi.mock('../../memory/MemoryRetriever', () => ({
  buildMemoryContext: () => null
}))

describe('chat IPC handlers', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.generate.mockReset()
    mocks.generate.mockResolvedValue({
      content: 'Done.',
      stats: { tokens: 1, durationMs: 10, tokensPerSecond: 100 },
      stopped: false
    })
  })

  it('passes the persisted conversation context snapshot into generation', async () => {
    registerChatHandlers()
    const handler = mocks.handlers.get(IpcChannel.Chat.send)
    expect(handler).toBeDefined()

    const context: ChatRequest['context'] = {
      activeSnapshot: {
        id: 'ctx1',
        createdAt: 1,
        reason: 'manual',
        throughMessageId: 'm2',
        removedTurns: 2,
        summary: 'The user has been improving a tic-tac-toe game.'
      }
    }

    await handler?.({ sender: { isDestroyed: () => false, send: vi.fn() } }, {
      conversationId: 'c1',
      messageId: 'm3',
      projectId: null,
      systemPrompt: 'be direct',
      context,
      history: [{ id: 'm2', role: 'assistant', content: 'Older answer.' }],
      prompt: 'continue',
      plan: null
    } satisfies ChatRequest)

    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ context }))
  })

  it('aborts the prior generation when a second send overlaps the same conversation', async () => {
    registerChatHandlers()
    const sendHandler = mocks.handlers.get(IpcChannel.Chat.send)
    const stopHandler = mocks.handlers.get(IpcChannel.Chat.stop)
    expect(sendHandler).toBeDefined()
    expect(stopHandler).toBeDefined()

    const signals: AbortSignal[] = []
    let resolveFirst: ((value: unknown) => void) | undefined
    const firstGeneration = new Promise((resolve) => {
      resolveFirst = resolve
    })
    let resolveSecond: ((value: unknown) => void) | undefined
    const secondGeneration = new Promise((resolve) => {
      resolveSecond = resolve
    })

    mocks.generate.mockReset()
    mocks.generate
      .mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
        signals.push(signal)
        return firstGeneration
      })
      .mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
        signals.push(signal)
        return secondGeneration
      })

    const request = (id: string) =>
      ({
        conversationId: 'shared',
        messageId: id,
        projectId: null,
        systemPrompt: '',
        context: undefined,
        history: [],
        prompt: 'hi',
        plan: null
      }) satisfies ChatRequest

    const event = { sender: { isDestroyed: () => false, send: vi.fn() } }

    const firstSend = sendHandler?.(event, request('m1'))
    // Let the first generate() call register before the second send overlaps it.
    await Promise.resolve()
    const secondSend = sendHandler?.(event, request('m2'))
    await Promise.resolve()

    expect(signals).toHaveLength(2)
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)

    resolveFirst?.({
      content: 'first (superseded)',
      stats: { tokens: 1, durationMs: 1, tokensPerSecond: 1 },
      stopped: false
    })
    await firstSend

    // The first request finishing must not clear the second, still-running
    // request's slot in the in-flight map.
    await stopHandler?.(event, 'shared')
    expect(signals[1].aborted).toBe(true)

    resolveSecond?.({
      content: 'second',
      stats: { tokens: 1, durationMs: 1, tokensPerSecond: 1 },
      stopped: true
    })
    await secondSend
  })

  /** A phone's turn is recorded on the computer, unless the phone's chat is temporary. */
  describe('a turn sent from a phone', () => {
    const phone = { [REMOTE_CLIENT]: { send: vi.fn(), isDestroyed: () => false } }
    const turn = (temporary?: boolean): ChatRequest => ({
      conversationId: 'c-phone',
      messageId: 'm1',
      projectId: null,
      history: [],
      prompt: 'hi',
      plan: null,
      ...(temporary === undefined ? {} : { temporary })
    })

    beforeEach(() => mocks.saveConversation.mockReset())

    it('is recorded into a conversation, the question as soon as it starts', async () => {
      // A conversation that existed only in the phone's memory until its first reply
      // finished could not be opened from an approval notification after the app
      // restarted.
      registerChatHandlers()
      let savedBeforeGenerating: unknown[] = []
      mocks.generate.mockImplementationOnce(() => {
        savedBeforeGenerating = mocks.saveConversation.mock.calls.map((call) => call[0])
        return Promise.resolve({
          content: 'hello',
          stats: { tokens: 1, durationMs: 1, tokensPerSecond: 1 }
        })
      })

      await mocks.handlers.get(IpcChannel.Chat.send)?.(phone, turn())

      expect(savedBeforeGenerating).toEqual([
        expect.objectContaining({
          id: 'c-phone',
          messages: [expect.objectContaining({ id: 'm1', role: 'user', content: 'hi' })]
        })
      ])
      expect(mocks.saveConversation).toHaveBeenCalledTimes(2)
    })

    it('is not recorded when the chat is temporary', async () => {
      registerChatHandlers()
      const result = await mocks.handlers.get(IpcChannel.Chat.send)?.(phone, turn(true))

      expect(result).toMatchObject({ ok: true })
      expect(mocks.saveConversation).not.toHaveBeenCalled()
    })
  })

  it('translates node-llama-cpp\'s raw "Object is disposed" error into an ask-to-retry message', async () => {
    registerChatHandlers()
    const handler = mocks.handlers.get(IpcChannel.Chat.send)

    mocks.generate.mockReset()
    mocks.generate.mockRejectedValue(new Error('Object is disposed'))

    const result = await handler?.({ sender: { isDestroyed: () => false, send: vi.fn() } }, {
      conversationId: 'c1',
      messageId: 'm1',
      projectId: null,
      systemPrompt: '',
      context: undefined,
      history: [],
      prompt: 'hi',
      plan: null
    } satisfies ChatRequest)

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'chat.generation-interrupted' }
    })
    const message = (result as { error: { message: string } }).error.message
    expect(message).not.toContain('Object is disposed')
    expect(message).toContain('reloaded')
  })

  it('translates a raw "terminated" stream error into an actionable vision-runtime message', async () => {
    registerChatHandlers()
    const handler = mocks.handlers.get(IpcChannel.Chat.send)

    mocks.generate.mockReset()
    // undici throws a bare `terminated` when the vision llama-server drops the
    // connection mid-reply — the user must never see that raw word.
    mocks.generate.mockRejectedValue(new Error('terminated'))

    const result = await handler?.({ sender: { isDestroyed: () => false, send: vi.fn() } }, {
      conversationId: 'c1',
      messageId: 'm1',
      projectId: null,
      systemPrompt: '',
      context: undefined,
      history: [],
      prompt: 'hi',
      plan: null
    } satisfies ChatRequest)

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'chat.vision-runtime-stopped' }
    })
    const message = (result as { error: { message: string } }).error.message
    expect(message).not.toBe('terminated')
    expect(message.toLowerCase()).toContain('memory')
  })
})
