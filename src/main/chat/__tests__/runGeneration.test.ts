import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRequest } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import type { GenerateOutcome, GenerateParams } from '../../llama/LlamaService'
import type { RunGenerationIo } from '../runGeneration'

/**
 * The body of `runGeneration` — the bookkeeping it does *after* a provider
 * returns, which nothing tested directly before. `historyBounding.test.ts`
 * covers the one pure helper it exports; the five other suites that import this
 * module drive it through `BoundedChatRunner`/`AgentRunService`/Critical
 * Thinking and assert on their own concerns.
 *
 * The mocks below are deliberately thin: this file is about what gets recorded
 * and what gets skipped, so every collaborator is stubbed to the least that
 * lets a turn complete, and the provider is scripted per test.
 */

const mocks = vi.hoisted(() => ({
  outcome: {} as GenerateOutcome,
  recordedEvents: [] as unknown[],
  recordedGenerations: [] as Array<Record<string, unknown>>,
  usageQueriedModelIds: [] as string[],
  activeProjectId: null as string | null,
  providerActive: 'local',
  /** Whether the scripted provider reports a successful write this turn. */
  writeDuringTurn: false
}))

vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: {
    get: () => ({
      generation: { turnTimeLimitMinutes: 15 },
      tools: { enabled: true, disabledTools: [] },
      general: { permissionMode: 'ask', defaultShell: '' },
      webSearch: {},
      email: {},
      memory: { crossChatEnabled: false, personalEnabled: false, confirmBeforeSaving: true },
      transcriptRecall: { cloudProviderEnabled: false },
      assistantStyle: { globalStyle: '' },
      provider: {
        active: mocks.providerActive,
        anthropic: { model: 'claude-x' },
        openai: { model: 'gpt-x' },
        azure: { deploymentName: '' },
        google: { model: 'gemini-x' }
      }
    })
  }
}))

vi.mock('../../projects/ProjectStore', () => ({
  projectStore: {
    getState: () => ({
      activeProjectId: mocks.activeProjectId,
      projects: mocks.activeProjectId
        ? [
            {
              id: mocks.activeProjectId,
              folderPath: 'C:\\ws',
              pinnedSkillNames: [],
              instructions: undefined,
              githubRepository: undefined
            }
          ]
        : []
    })
  }
}))

vi.mock('../../projects/ProjectMemoryStore', () => ({
  projectMemoryStore: {
    recordEvent: (projectId: string, event: unknown) =>
      mocks.recordedEvents.push({ projectId, event })
  }
}))

vi.mock('../../stats/TokenActivityStore', () => ({
  tokenActivityStore: {
    recordGeneration: (entry: Record<string, unknown>) => mocks.recordedGenerations.push(entry),
    getTodayTokensForModelIds: (ids: readonly string[]) => {
      mocks.usageQueriedModelIds = [...ids]
      return 0
    }
  }
}))

vi.mock('../../llm/ProviderRegistry', () => ({
  getActiveProvider: () => ({
    id: 'test',
    generate: (params: GenerateParams) => {
      // Tool activity has to land *during* the turn, the way a real provider
      // reports it — the recording under test reads what those callbacks
      // accumulated, so firing them afterwards would prove nothing.
      if (mocks.writeDuringTurn) {
        params.tools?.onActivity({
          id: 'call-1',
          name: 'write_file',
          kind: 'write',
          status: 'success',
          touchedPaths: ['src/theme.css']
        } as unknown as ToolCall)
      }
      return Promise.resolve(mocks.outcome)
    }
  })
}))

vi.mock('../../llama/LlamaService', () => ({
  llamaService: {
    getState: () => ({
      status: 'ready',
      generating: false,
      model: { id: 'local-x', name: 'Local X' }
    }),
    countPromptTokens: (prompt: string) => prompt.length,
    summarizeForCompactionLocal: () => Promise.resolve(null)
  }
}))

vi.mock('../../llm/ProviderUsageStore', () => ({
  providerUsageStore: { recordTodayTokens: () => {} }
}))

vi.mock('../../mcp/McpManager', () => ({ mcpManager: { listTools: () => [] } }))
vi.mock('../../memory/MemoryRetriever', () => ({ buildMemoryContext: () => null }))
vi.mock('../../recall/transcriptRecallContext', () => ({
  buildTranscriptRecallContext: () => null
}))
vi.mock('../../skills/SkillStore', () => ({ skillStore: { list: () => [] } }))
vi.mock('../../tools/workspaceContext', () => ({ buildWorkspaceContext: () => null }))
vi.mock('../../checkpoints/CheckpointStore', () => ({
  checkpointStore: { getSummary: () => null }
}))
vi.mock('../../llama/contextAssembler', () => ({
  boundHistoryForStatelessProvider: (_s: string, history: unknown[]) =>
    Promise.resolve({ systemPrompt: 's', history, omittedTurns: 0 })
}))

const { runGeneration } = await import('../runGeneration')

function outcome(overrides: Partial<GenerateOutcome> = {}): GenerateOutcome {
  return {
    content: 'Done.',
    stats: { tokens: 10, durationMs: 100, tokensPerSecond: 100 },
    stopped: false,
    ...overrides
  }
}

function request(): ChatRequest {
  return {
    conversationId: 'c1',
    messageId: 'm1',
    history: [],
    prompt: 'Add a dark mode toggle.'
  }
}

const io: RunGenerationIo = { confirm: () => Promise.resolve({ approved: false }) }

beforeEach(() => {
  mocks.outcome = outcome()
  mocks.recordedEvents.length = 0
  mocks.recordedGenerations.length = 0
  mocks.usageQueriedModelIds = []
  mocks.activeProjectId = 'p1'
  mocks.providerActive = 'local'
  mocks.writeDuringTurn = false
})

describe('runGeneration — project memory', () => {
  it('records the files a turn changed even when the turn was stopped', async () => {
    // The gate used to be `!outcome.stopped`, which dropped exactly the long,
    // productive turns a bounded stop is designed to preserve. This ledger
    // feeds the next turn's system prompt via buildWorkspaceContext, so those
    // writes went missing from the project's working memory entirely.
    mocks.writeDuringTurn = true
    mocks.outcome = outcome({ stopped: true, stopReason: 'context-limit' })

    await runGeneration(request(), io)

    expect(mocks.recordedEvents).toHaveLength(1)
    const { event } = mocks.recordedEvents[0] as { event: { changedFiles: string[] } }
    expect(event.changedFiles).toEqual(['src/theme.css'])
  })

  it('still records nothing when a turn touched no tools', async () => {
    // Regression guard: the `hadToolActivity` half of the condition carries the
    // weight now, so it has to keep holding on its own.
    mocks.outcome = outcome({ stopped: true, stopReason: 'context-limit' })

    await runGeneration(request(), io)

    expect(mocks.recordedEvents).toHaveLength(0)
  })

  it('records nothing for a general chat with no project', async () => {
    mocks.activeProjectId = null
    mocks.writeDuringTurn = true

    await runGeneration(request(), io)

    expect(mocks.recordedEvents).toHaveLength(0)
  })
})

describe('runGeneration — token activity', () => {
  it('records a turn that cost input tokens but produced no output', async () => {
    // Gating the whole block on output alone kept genuinely billed input out
    // of the daily-cap tally.
    mocks.outcome = outcome({
      content: '',
      stats: { tokens: 0, durationMs: 100, tokensPerSecond: 0, inputTokens: 4_000 }
    })

    await runGeneration(request(), io)

    expect(mocks.recordedGenerations).toHaveLength(1)
    expect(mocks.recordedGenerations[0].inputTokens).toBe(4_000)
  })

  it('prefers a transport-reported input figure over the new-prompt proxy', async () => {
    mocks.outcome = outcome({
      stats: { tokens: 10, durationMs: 100, tokensPerSecond: 100, inputTokens: 9_999 }
    })

    await runGeneration(request(), io)

    expect(mocks.recordedGenerations[0].inputTokens).toBe(9_999)
  })

  it('falls back to the new-prompt proxy when no transport figure exists', async () => {
    // The node-llama-cpp engine reuses its KV cache rather than re-billing the
    // context, so it genuinely has no prompt-token figure to report.
    await runGeneration(request(), io)

    expect(mocks.recordedGenerations[0].inputTokens).toBe(request().prompt.length)
  })

  it('asks the usage gauge for the model that actually ran, catalog or not', async () => {
    // Usage is recorded against this id, so an id the catalog omits is spend
    // the gauge can never see. Catalogs ship with the app while the configured
    // model is persisted settings, so the two can drift across releases.
    mocks.providerActive = 'google'

    await runGeneration(request(), io)

    expect(mocks.usageQueriedModelIds).toContain('gemini-x')
  })
})
