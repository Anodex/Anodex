import { afterEach, describe, expect, it, vi } from 'vitest'
import { llamaService, type GenerateParams } from '../LlamaService'
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
  llama:
    | {
        createGrammarForJsonSchema: (schema: Record<string, unknown>) => Promise<unknown>
      }
    | undefined
  session:
    | {
        promptWithMeta: (
          prompt: unknown,
          options: {
            onResponseChunk?: (chunk: unknown) => void
            functions?: Record<string, { handler: (params: unknown) => unknown }>
            grammar?: unknown
            maxTokens?: number
            signal?: AbortSignal
            budgets?: { thoughtTokens?: number; commentTokens?: number }
            onFunctionCallParamsChunk?: (chunk: {
              callIndex: number
              functionName: string
              paramsChunk: string
              done: boolean
            }) => void
          }
        ) => unknown
        dispose: () => void
        chatWrapper: typeof fakeChatWrapper
        getChatHistory: () => Array<{ type: 'system'; text: string }>
      }
    | undefined
  activeConversationId: string | undefined
  generating: boolean
  ensureSession: (...args: unknown[]) => Promise<NonNullable<LlamaServiceTestAccess['session']>>
  activeContextShiftHandler?: () => void
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
  access.llama = undefined
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

function webOnlyTools(onActivity: NonNullable<GenerateParams['tools']>['onActivity'] = () => {}) {
  return {
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
    disabledTools: new Set<string>(),
    mcpTools: [],
    onActivity,
    confirm: () => Promise.resolve({ approved: true })
  } satisfies NonNullable<GenerateParams['tools']>
}

afterEach(() => {
  vi.restoreAllMocks()
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
  it('forces a fresh native session only for explicitly isolated phases', async () => {
    const access = asTestAccess()
    prepareFakeEngine(access)
    const session: NonNullable<LlamaServiceTestAccess['session']> = {
      promptWithMeta: vi.fn(() =>
        Promise.resolve({ response: [], responseText: 'done', stopReason: 'eogToken' })
      ),
      dispose: vi.fn(),
      chatWrapper: fakeChatWrapper,
      getChatHistory: () => [{ type: 'system', text: 'Test system prompt.' }]
    }
    const ensureSession = vi.spyOn(access, 'ensureSession').mockResolvedValue(session)

    await llamaService.generate({
      conversationId: 'test-conversation',
      messageId: 'isolated-message',
      history: [],
      prompt: 'isolated phase',
      sessionMode: 'isolated',
      onToken: () => {}
    })
    await llamaService.generate({
      conversationId: 'test-conversation',
      messageId: 'ordinary-message',
      history: [],
      prompt: 'ordinary turn',
      onToken: () => {}
    })

    expect(ensureSession.mock.calls.map((call) => call[6])).toEqual([true, false])
  })

  it('enforces a requested JSON schema with a local grammar on tool-free turns', async () => {
    const access = asTestAccess()
    prepareFakeEngine(access)
    const grammar = { kind: 'test-json-grammar' }
    const createGrammarForJsonSchema = vi.fn(() => Promise.resolve(grammar))
    access.llama = { createGrammarForJsonSchema }
    const promptWithMeta = vi.fn((_prompt: unknown, _options: { grammar?: unknown }) =>
      Promise.resolve({ response: [], responseText: '{"ok":true}', stopReason: 'eogToken' })
    )
    access.session = {
      promptWithMeta,
      dispose: vi.fn(),
      chatWrapper: fakeChatWrapper,
      getChatHistory: () => [{ type: 'system', text: 'Test system prompt.' }]
    }
    const schema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false
    }

    await llamaService.generate({
      conversationId: 'test-conversation',
      messageId: 'json-message',
      history: [],
      prompt: 'return JSON',
      options: { jsonSchema: schema },
      onToken: () => {}
    })

    expect(createGrammarForJsonSchema).toHaveBeenCalledWith(schema)
    expect(promptWithMeta.mock.calls[0]?.[1]).toMatchObject({ grammar })
  })

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

  it('preserves streamed text when an abort throws before the native round returns', async () => {
    const access = asTestAccess()
    prepareFakeEngine(access)
    const controller = new AbortController()
    access.session = {
      promptWithMeta: vi.fn(
        (_prompt: unknown, options: { onResponseChunk?: (chunk: unknown) => void }) => {
          options.onResponseChunk?.({
            type: undefined,
            segmentType: undefined,
            text: 'Useful partial audit text.',
            tokens: [1, 2, 3]
          })
          controller.abort()
          throw new Error('aborted')
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
      signal: controller.signal,
      onToken: () => {}
    })

    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('user')
    expect(outcome.content).toBe('Useful partial audit text.')
  })

  it('preserves partial output and reports the effective local token ceiling', async () => {
    const access = asTestAccess()
    prepareFakeEngine(access)
    const observedMaxTokens: number[] = []
    access.session = {
      promptWithMeta: vi.fn(
        (
          _prompt: unknown,
          options: {
            maxTokens?: number
            onResponseChunk?: (chunk: unknown) => void
          }
        ) => {
          observedMaxTokens.push(options.maxTokens ?? -1)
          options.onResponseChunk?.({
            type: undefined,
            segmentType: undefined,
            text: 'Useful work before the output ceiling.',
            tokens: [1, 2, 3]
          })
          return Promise.resolve({
            response: [],
            responseText: 'Useful work before the output ceiling.',
            stopReason: 'maxTokens'
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
      prompt: 'write a long explanation',
      options: { maxTokens: 8_192 },
      onToken: () => {}
    })

    expect(observedMaxTokens).toHaveLength(1)
    expect(observedMaxTokens[0]).toBeLessThan(8_192)
    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('token-limit')
    expect(outcome.content).toBe('Useful work before the output ceiling.')
    expect(outcome.contextBudget?.requestedMaxOutputTokens).toBe(8_192)
    expect(outcome.contextBudget?.effectiveMaxOutputTokens).toBe(observedMaxTokens[0])
  })

  it('enforces the output ceiling across hidden function-argument chunks', async () => {
    const access = asTestAccess()
    prepareFakeEngine(access)
    access.model = {
      tokenizer: () => [],
      tokenize: (text: string) => Array.from({ length: text.length })
    }
    access.session = {
      promptWithMeta: vi.fn(
        (
          _prompt: unknown,
          options: {
            signal?: AbortSignal
            onResponseChunk?: (chunk: unknown) => void
            onFunctionCallParamsChunk?: (chunk: {
              callIndex: number
              functionName: string
              paramsChunk: string
              done: boolean
            }) => void
          }
        ) => {
          options.onResponseChunk?.({
            type: undefined,
            segmentType: undefined,
            text: 'Starting the audit.',
            tokens: [1]
          })
          options.onFunctionCallParamsChunk?.({
            callIndex: 0,
            functionName: 'web_search',
            // Must exceed this fixture's *measured* effective ceiling (6,465
            // tokens, from its 140-token fixed prompt — see
            // resolveLocalOutputBudget), not the old flat quarter-context
            // value this literal was originally sized against.
            paramsChunk: 'x'.repeat(7_000),
            done: false
          })
          expect(options.signal?.aborted).toBe(true)
          throw new Error('generation aborted by output watchdog')
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
      prompt: 'audit the project',
      options: { maxTokens: 8_192 },
      onToken: () => {},
      tools: webOnlyTools()
    })

    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('token-limit')
    expect(outcome.content).toBe('Starting the audit.')
    expect(outcome.stats.tokens).toBeGreaterThanOrEqual(2_048)
    // P0-C: the visible reply and thinking were tiny, so the diagnostics must
    // show where the rest of the budget actually went — an unfinished
    // web_search call's parameters, not excess thought or prose.
    expect(outcome.generationDiagnostics?.visibleTokens).toBe(1)
    expect(outcome.generationDiagnostics?.functionParameterTokens).toBeGreaterThanOrEqual(7_000)
    expect(outcome.generationDiagnostics?.unfinishedFunctionName).toBe('web_search')
    expect(outcome.generationDiagnostics?.unfinishedFunctionParameterChars).toBe(7_000)
    expect(outcome.generationDiagnostics?.completedToolCalls).toBe(0)
  })

  describe('reasoning/output channel budget (P0-B)', () => {
    it('forwards a requested thoughtTokens budget, clamped to this turn’s measured ceiling', async () => {
      const access = asTestAccess()
      prepareFakeEngine(access)
      access.model = { tokenizer: () => [] }
      let observedBudgets: { thoughtTokens?: number; commentTokens?: number } | undefined
      access.session = {
        promptWithMeta: vi.fn(
          (
            _prompt: unknown,
            options: {
              budgets?: { thoughtTokens?: number; commentTokens?: number }
              onResponseChunk?: (chunk: unknown) => void
            }
          ) => {
            observedBudgets = options.budgets
            options.onResponseChunk?.({
              type: undefined,
              segmentType: undefined,
              text: 'Done.',
              tokens: [1]
            })
            return Promise.resolve({ response: [], responseText: 'Done.', stopReason: 'eogToken' })
          }
        ),
        dispose: vi.fn(),
        chatWrapper: fakeChatWrapper,
        getChatHistory: () => [{ type: 'system', text: 'Test system prompt.' }]
      }

      await llamaService.generate({
        conversationId: 'test-conversation',
        messageId: 'test-message',
        history: [],
        prompt: 'synthesize the report',
        // Requests far more thought room than this turn's small fixed-token
        // fixture actually has available — the request must be clamped down
        // to the measured ceiling, never passed through as-is.
        options: { maxTokens: 100, thoughtTokens: 100_000 },
        onToken: () => {}
      })

      expect(observedBudgets?.thoughtTokens).toBeDefined()
      expect(observedBudgets?.thoughtTokens).toBeLessThanOrEqual(100)
    })

    it('applies a default thought budget for a tool-enabled turn when none was explicitly requested', async () => {
      const access = asTestAccess()
      prepareFakeEngine(access)
      access.model = { tokenizer: () => [] }
      let observedBudgets: { thoughtTokens?: number; commentTokens?: number } | undefined
      access.session = {
        promptWithMeta: vi.fn(
          (
            _prompt: unknown,
            options: {
              budgets?: { thoughtTokens?: number; commentTokens?: number }
              onResponseChunk?: (chunk: unknown) => void
            }
          ) => {
            observedBudgets = options.budgets
            options.onResponseChunk?.({
              type: undefined,
              segmentType: undefined,
              text: 'Done.',
              tokens: [1]
            })
            return Promise.resolve({ response: [], responseText: 'Done.', stopReason: 'eogToken' })
          }
        ),
        dispose: vi.fn(),
        chatWrapper: fakeChatWrapper,
        getChatHistory: () => [{ type: 'system', text: 'Test system prompt.' }]
      }

      await llamaService.generate({
        conversationId: 'test-conversation',
        messageId: 'test-message',
        history: [],
        prompt: 'audit the project',
        // No explicit thoughtTokens — this is the ordinary chat call shape.
        options: { maxTokens: 8_192 },
        onToken: () => {},
        tools: webOnlyTools()
      })

      // A live 8K run reproduced hidden reasoning (3,432 chars) dwarfing
      // visible output (223 chars) on exactly this call shape (tool-enabled,
      // no explicit budget) — this default is what now bounds that.
      expect(observedBudgets?.thoughtTokens).toBeDefined()
      expect(observedBudgets!.thoughtTokens!).toBeGreaterThan(0)
    })

    it('omits budgets entirely for a tool-less turn when no thoughtTokens was requested', async () => {
      const access = asTestAccess()
      prepareFakeEngine(access)
      access.model = { tokenizer: () => [] }
      let observedBudgets: { thoughtTokens?: number; commentTokens?: number } | undefined
      access.session = {
        promptWithMeta: vi.fn(
          (
            _prompt: unknown,
            options: {
              budgets?: { thoughtTokens?: number; commentTokens?: number }
              onResponseChunk?: (chunk: unknown) => void
            }
          ) => {
            observedBudgets = options.budgets
            options.onResponseChunk?.({
              type: undefined,
              segmentType: undefined,
              text: 'Done.',
              tokens: [1]
            })
            return Promise.resolve({ response: [], responseText: 'Done.', stopReason: 'eogToken' })
          }
        ),
        dispose: vi.fn(),
        chatWrapper: fakeChatWrapper,
        getChatHistory: () => [{ type: 'system', text: 'Test system prompt.' }]
      }

      await llamaService.generate({
        conversationId: 'test-conversation',
        messageId: 'test-message',
        history: [],
        prompt: 'a normal chat message',
        options: { maxTokens: 512 },
        onToken: () => {}
      })

      expect(observedBudgets).toBeUndefined()
    })
  })

  describe('generation diagnostics (P0-C)', () => {
    it('splits visible and thought tokens, and clears the in-flight call once it settles', async () => {
      // Regression fixture for the live 8K project-chat exit gate: 135 visible
      // characters and 159 thought characters against 2,035 output tokens
      // with zero completed tool calls (see
      // docs/CONTEXT_ADAPTIVE_RUNTIME_RECOVERY_HANDOFF.md, P0-C). Here the
      // call actually completes, so diagnostics must show a settled call with
      // nothing left unfinished — the opposite of that failure.
      const access = asTestAccess()
      prepareFakeEngine(access)
      access.model = {
        tokenizer: () => [],
        tokenize: (text: string) => Array.from({ length: text.length })
      }
      access.session = {
        promptWithMeta: vi.fn(
          async (
            _prompt: unknown,
            options: {
              onResponseChunk?: (chunk: unknown) => void
              onFunctionCallParamsChunk?: (chunk: {
                callIndex: number
                functionName: string
                paramsChunk: string
                done: boolean
              }) => void
              functions?: Record<string, { handler: (params: unknown) => unknown }>
            }
          ) => {
            options.onResponseChunk?.({
              type: 'segment',
              segmentType: 'thought',
              text: 'thinking about the request',
              tokens: [1, 2, 3, 4, 5]
            })
            options.onFunctionCallParamsChunk?.({
              callIndex: 0,
              functionName: 'web_search',
              paramsChunk: '{"query":"bee stings"}',
              done: true
            })
            await Promise.resolve(
              options.functions?.web_search?.handler({ query: 'bee stings' })
            ).catch(() => null)
            options.onResponseChunk?.({
              type: undefined,
              segmentType: undefined,
              text: 'Done searching.',
              tokens: [1, 2]
            })
            return {
              response: [],
              responseText: 'Done searching.',
              stopReason: 'eogToken'
            }
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
        prompt: 'search for something',
        onToken: () => {},
        tools: webOnlyTools()
      })

      expect(outcome.generationDiagnostics?.thoughtTokens).toBe(5)
      expect(outcome.generationDiagnostics?.visibleTokens).toBe(2)
      expect(outcome.generationDiagnostics?.completedToolCalls).toBe(1)
      expect(outcome.generationDiagnostics?.unfinishedFunctionName).toBeUndefined()
      expect(outcome.generationDiagnostics?.unfinishedFunctionParameterChars).toBeUndefined()
    })

    it("counts mid-generation context shifts (node-llama-cpp's own contextShift.strategy), not just whole-session recompaction", async () => {
      // Regression: a live 8K audit turn logged 7 "Context shift: folded..."
      // events (node-llama-cpp's own `onShift`, wired up once per session in
      // `ensureSession` — see `this.activeContextShiftHandler`) inside a
      // single generation round, but `generationDiagnostics.contextShifts`
      // still reported 0 — it was only wired to the separate, far rarer
      // whole-session `recompactSession` retries. `onShift` fires through
      // `this.activeContextShiftHandler`, set once per `generate()` call;
      // this fake session invokes it directly, exactly as the real
      // `createBoundedContextShiftStrategy` would mid-stream.
      const access = asTestAccess()
      prepareFakeEngine(access)
      let observedExternalShiftCalls = 0

      access.session = {
        promptWithMeta: vi.fn(
          (_prompt: unknown, options: { onResponseChunk?: (chunk: unknown) => void }) => {
            access.activeContextShiftHandler?.()
            access.activeContextShiftHandler?.()
            options.onResponseChunk?.({
              type: undefined,
              segmentType: undefined,
              text: 'Done after two mid-turn shifts.',
              tokens: [1, 2, 3]
            })
            return Promise.resolve({
              response: [],
              responseText: 'Done after two mid-turn shifts.',
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
        prompt: 'a long turn that shifts mid-generation',
        onToken: () => {},
        onContextShift: () => {
          observedExternalShiftCalls += 1
        }
      })

      expect(outcome.generationDiagnostics?.contextShifts).toBe(2)
      // The pre-existing caller-facing notification still fires too.
      expect(observedExternalShiftCalls).toBe(2)
    })
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

    const observedParallelLimits: Array<number | undefined> = []
    const promptWithMeta = vi.fn(
      async (
        _prompt: unknown,
        options: {
          functions?: Record<string, { handler: (params: unknown) => unknown }>
          maxParallelFunctionCalls?: number
        }
      ) => {
        observedParallelLimits.push(options.maxParallelFunctionCalls)
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
      tools: webOnlyTools((call) => activityKinds.push(call.status))
    })

    // The retry never fires: exactly one promptWithMeta call, not two.
    expect(promptWithMeta).toHaveBeenCalledOnce()
    expect(observedParallelLimits).toEqual([1])
    expect(activityKinds.length).toBeGreaterThan(0) // the tool really did run
    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('context-limit')
  })
})
