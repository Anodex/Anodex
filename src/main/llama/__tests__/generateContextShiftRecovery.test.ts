import { afterEach, describe, expect, it, vi } from 'vitest'
import { llamaService } from '../LlamaService'
import {
  NODE_LLAMA_CPP_CONTEXT_SHIFT_CRASH_FRAGMENT,
  NODE_LLAMA_CPP_CONTEXT_TOO_LONG_CRASH_FRAGMENT
} from '../compaction'

/**
 * Behavioral regression tests for `LlamaService.generate()`'s recovery from
 * node-llama-cpp's two distinct, unversioned context-shift crash messages
 * (see the two `NODE_LLAMA_CPP_CONTEXT_*_CRASH_FRAGMENT` constants in
 * `compaction.ts`, and their own trip-wire tests in `compaction.test.ts`
 * confirming the fragments still match the installed dependency).
 *
 * Those trip-wire tests only prove the *string* still matches — they say
 * nothing about whether `generate()` actually degrades gracefully when the
 * error fires. These tests force each fragment through a real call to
 * `generate()` (with a hand-built fake session standing in for
 * node-llama-cpp's own, so no native model needs to be loaded) and assert on
 * the actual returned outcome: partial content preserved, `stopped: true`,
 * and the distinct `'context-limit'` stop reason — not the raw crash
 * bubbling up as an unhandled rejection, which is exactly what reached
 * `CriticalThinkingService` before this fix (see git history for the
 * original bug report: a Critical Thinking run with 69 sources surfaced the
 * raw node-llama-cpp error text as its `lastError`).
 *
 * Reaches into `LlamaService`'s private fields directly (`as unknown as
 * {...}`) rather than driving a real `loadModel()` — the singleton has no
 * dependency-injection seam for its native model/session, and standing up a
 * full fake `node-llama-cpp` module just to satisfy `ensureSession()`'s
 * from-scratch path is unnecessary: pre-seeding `session`/
 * `activeConversationId` so they already match hits `ensureSession`'s own
 * fast-path return (see `LlamaService.ts`), reaching the exact code under
 * test without faking anything neither test depends on.
 */

interface LlamaServiceTestAccess {
  status: string
  context: unknown
  contextSize: number | undefined
  model: unknown
  session:
    | {
        promptWithMeta: (
          prompt: unknown,
          options: {
            onResponseChunk?: (chunk: unknown) => void
            functions?: Record<string, { handler: (params: unknown) => unknown }>
          }
        ) => unknown
        dispose: () => void
        chatWrapper: typeof fakeChatWrapper
        getChatHistory: () => Array<{ type: 'system'; text: string }>
      }
    | undefined
  activeConversationId: string | undefined
  generating: boolean
}

function asTestAccess(): LlamaServiceTestAccess {
  return llamaService as unknown as LlamaServiceTestAccess
}

function resetLlamaServiceState(): void {
  const access = asTestAccess()
  access.status = 'unloaded'
  access.context = undefined
  access.contextSize = undefined
  access.model = undefined
  access.session = undefined
  access.activeConversationId = undefined
  access.generating = false
}

const fakeChatWrapper = {
  generateInitialChatHistory: ({ systemPrompt }: { systemPrompt?: string }) =>
    systemPrompt ? [{ type: 'system' as const, text: systemPrompt }] : [],
  generateContextState: ({
    chatHistory,
    availableFunctions
  }: {
    chatHistory: unknown[]
    availableFunctions?: Record<string, unknown>
  }) => ({
    contextText: {
      tokenize: () =>
        Array.from({
          length: 100 + chatHistory.length * 10 + Object.keys(availableFunctions ?? {}).length * 10
        })
    }
  })
}

function prepareFakeEngine(access: LlamaServiceTestAccess): void {
  access.status = 'ready'
  access.context = {}
  access.contextSize = 8_192
  access.model = { tokenizer: () => [] }
  access.activeConversationId = 'test-conversation'
}

afterEach(() => {
  resetLlamaServiceState()
})

/** Stream some visible text via `onResponseChunk`, then throw a context-shift crash — mirrors the real failure: substantial content had already streamed before node-llama-cpp gave up. */
function fakeSessionThrowingMidStream(crashMessage: string): LlamaServiceTestAccess['session'] {
  return {
    promptWithMeta: vi.fn(
      (_prompt: unknown, options: { onResponseChunk?: (chunk: unknown) => void }) => {
        options.onResponseChunk?.({
          type: undefined,
          segmentType: undefined,
          text: 'Partial findings before the crash.',
          tokens: [1, 2, 3]
        })
        throw new Error(crashMessage)
      }
    ),
    dispose: vi.fn(),
    chatWrapper: fakeChatWrapper,
    getChatHistory: () => [{ type: 'system', text: 'Test system prompt.' }]
  }
}

async function runAgainstFakeSession(crashMessage: string) {
  const access = asTestAccess()
  prepareFakeEngine(access)
  access.session = fakeSessionThrowingMidStream(crashMessage)

  return llamaService.generate({
    conversationId: 'test-conversation',
    messageId: 'test-message',
    history: [],
    prompt: 'investigate something with lots of sources',
    onToken: () => {}
  })
}

describe('LlamaService.generate() context-shift recovery', () => {
  it('reports an irreducible fixed-context limit before decoding or retrying', async () => {
    const access = asTestAccess()
    prepareFakeEngine(access)
    const promptWithMeta = vi.fn()
    access.session = {
      promptWithMeta,
      dispose: vi.fn(),
      chatWrapper: {
        ...fakeChatWrapper,
        generateContextState: () => ({
          contextText: { tokenize: () => Array.from({ length: 8_000 }) }
        })
      },
      getChatHistory: () => [{ type: 'system', text: 'Test system prompt.' }]
    }

    const outcome = await llamaService.generate({
      conversationId: 'test-conversation',
      messageId: 'test-message',
      history: [],
      prompt: 'hello',
      onToken: () => {}
    })

    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('fixed-context-limit')
    expect(outcome.contextBudget?.fixedTokens).toBe(8_000)
    expect(promptWithMeta).not.toHaveBeenCalled()
  })

  it('degrades gracefully instead of throwing when node-llama-cpp reports the "history that fits" crash', async () => {
    const outcome = await runAgainstFakeSession(
      `The default context shift strategy ${NODE_LLAMA_CPP_CONTEXT_SHIFT_CRASH_FRAGMENT}. ` +
        'This may happen due to the system prompt being too long'
    )

    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('context-limit')
    expect(outcome.content).toContain('Partial findings before the crash.')
  })

  it('degrades gracefully instead of throwing when node-llama-cpp reports the "too long prompt" crash', async () => {
    const outcome = await runAgainstFakeSession(
      'Failed to compress chat history for context shift due to a too long prompt or system message ' +
        `${NODE_LLAMA_CPP_CONTEXT_TOO_LONG_CRASH_FRAGMENT}. Consider increasing the context size or ` +
        'shortening the long prompt or system message.'
    )

    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('context-limit')
    expect(outcome.content).toContain('Partial findings before the crash.')
  })

  it('does not treat an unrelated error as a context-shift crash', async () => {
    await expect(runAgainstFakeSession('some unrelated native failure')).rejects.toThrow(
      'some unrelated native failure'
    )
  })

  it('keeps streamed model text instead of exposing strings reconstructed from compacted history', async () => {
    const access = asTestAccess()
    prepareFakeEngine(access)
    access.session = {
      promptWithMeta: vi.fn(
        (_prompt: unknown, options: { onResponseChunk?: (chunk: unknown) => void }) => {
          options.onResponseChunk?.({
            type: undefined,
            segmentType: undefined,
            text: 'The actual generated answer.',
            tokens: [1, 2, 3]
          })
          return Promise.resolve({
            response: [],
            responseText: 'Pre-shift narration.\n\n(10 earlier tool calls omitted to fit context)',
            stopReason: 'eogToken'
          })
        }
      ),
      dispose: vi.fn(),
      chatWrapper: fakeChatWrapper,
      getChatHistory: () => [{ type: 'system', text: 'Test system prompt.' }]
    }

    const outcome = await llamaService.generate({
      conversationId: 'test-conversation',
      messageId: 'test-message',
      history: [],
      prompt: 'audit this project',
      onToken: () => {}
    })

    expect(outcome.content).toBe('The actual generated answer.')
    expect(outcome.content).not.toContain('tool calls omitted')
  })

  it('does not retry (and risk repeating a completed tool call) when a tool already ran this round before the crash', async () => {
    // Regression: the round-0 retry rebuilds the session from PERSISTED
    // history and resends the ORIGINAL prompt from scratch — safe only if
    // truly nothing happened yet. Native function calling can execute
    // several tool calls (real side effects: a file written, a command run)
    // within round 0's single `promptWithMeta()` call with zero visible
    // narration text between them, so `roundContent`/`roundSegment` being
    // empty does NOT mean nothing happened. This test drives the REAL
    // `web_search` tool handler (via `buildToolFunctions`, not a
    // reimplementation) so `hadAnyToolAttempt` is set the same way
    // production sets it, then crashes with zero streamed text — the retry
    // must not fire.
    const access = asTestAccess()
    prepareFakeEngine(access)

    const promptWithMeta = vi.fn(
      async (
        _prompt: unknown,
        options: { functions?: Record<string, { handler: (params: unknown) => unknown }> }
      ) => {
        // Simulates the model calling a tool with no preceding narration —
        // `web_search` with a configured-but-keyless provider errors fast on
        // the missing API key, no real network call.
        await Promise.resolve(
          options.functions?.web_search?.handler({ query: 'bee stings' })
        ).catch(() => null)
        throw new Error(
          `The default context shift strategy ${NODE_LLAMA_CPP_CONTEXT_SHIFT_CRASH_FRAGMENT}.`
        )
      }
    )
    access.session = {
      promptWithMeta,
      dispose: vi.fn(),
      chatWrapper: fakeChatWrapper,
      getChatHistory: () => [{ type: 'system', text: 'Test system prompt.' }]
    }

    const activityKinds: string[] = []
    const outcome = await llamaService.generate({
      conversationId: 'test-conversation',
      messageId: 'test-message',
      history: [],
      prompt: 'investigate bee stings',
      onToken: () => {},
      tools: {
        workspaceRoot: null,
        projectId: null,
        permissionMode: 'untethered',
        webSearch: {
          provider: 'brave',
          apiKey: '',
          searchEngineId: '',
          baseUrl: '',
          resultCount: 5,
          requireApproval: false
        },
        email: {
          provider: 'none',
          gmail: {
            enabled: false,
            address: '',
            oauthClientId: '',
            oauthClientSecret: '',
            syncMode: 'metadata',
            sendRequiresApproval: true
          }
        },
        memory: { crossChatEnabled: false, personalEnabled: false, confirmBeforeSaving: false },
        plan: null,
        enabledTools: new Set(['web_search']),
        disabledTools: new Set(),
        mcpTools: [],
        onActivity: (call) => activityKinds.push(call.status),
        confirm: () => Promise.resolve({ approved: true })
      }
    })

    // The retry never fires: exactly one promptWithMeta call, not two.
    expect(promptWithMeta).toHaveBeenCalledOnce()
    expect(activityKinds.length).toBeGreaterThan(0) // the tool really did run
    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('context-limit')
  })
})
