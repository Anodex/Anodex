import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '@shared/ipc'
import type { ChatRequest } from '@shared/chat.types'
import { registerChatHandlers } from '../chat.handlers'

type IpcTestHandler = (event: unknown, request: unknown) => unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcTestHandler>(),
  generate: vi.fn(),
  recordSummary: vi.fn(),
  recordGeneration: vi.fn()
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
      webSearch: { provider: 'duckduckgo', requireApproval: false },
      memory: { crossChatEnabled: false, personalEnabled: false },
      transcriptRecall: {
        enabled: false,
        crossScopeEnabled: false,
        archivedEnabled: false,
        cloudProviderEnabled: false
      },
      ui: { systemPrompt: '' },
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
    generateChatTitle: vi.fn()
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
})
