import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerateParams } from '../../llama/LlamaService'
import type { ModelToolResultBudget } from '../../tools/modelResultBudget'

/**
 * Two failures the cloud providers shared with the local vision transport,
 * pinned here because they are invisible until a turn runs long:
 *
 * - Tool results were never bounded by the room the turn had left. Every
 *   provider passed `modelResultBudget: { current: null }` permanently, so
 *   `clampModelResultCap` handed back whatever cap the tool asked for — 60 KB
 *   for `read_file`, 180 KB for `code_outline` — up to 20 rounds, each one
 *   re-sent and re-billed on every later round.
 * - A round that failed threw, discarding the whole outcome. The interactive
 *   renderer keeps the text it already streamed, but `boundedChatRunner` has no
 *   catch of its own, so a multi-cycle reply lost every earlier cycle as well.
 */

interface ScriptedRound {
  /** Ask for a tool call this round instead of finishing. */
  toolCall?: boolean
  /** Fail the round with this error. */
  error?: Error
  /** Visible text this round streams. */
  text?: string
  /** Prompt tokens the provider reports for this round. */
  inputTokens?: number
}

const mocks = vi.hoisted(() => ({
  rounds: [] as ScriptedRound[],
  openAiRequests: [] as Record<string, unknown>[],
  anthropicRequests: [] as Record<string, unknown>[],
  /** `modelResultBudget.current` sampled at each tool invocation, in order. */
  budgetsAtToolTime: [] as Array<ModelToolResultBudget | null>,
  toolContext: null as { modelResultBudget: { current: ModelToolResultBudget | null } } | null
}))

vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: {
    get: () => ({
      provider: {
        openai: { apiKey: 'openai-key', model: 'gpt-5' },
        anthropic: { apiKey: 'anthropic-key', model: 'claude-opus-4-1-20250805' }
      }
    })
  }
}))

vi.mock('../../tools/registry', () => ({
  buildTools: (
    _define: unknown,
    ctx: { modelResultBudget: { current: ModelToolResultBudget | null } }
  ) => {
    mocks.toolContext = ctx
    return {
      read_file: {
        description: 'Read a file.',
        params: { type: 'object', properties: {} },
        handler: () => {
          mocks.budgetsAtToolTime.push(ctx.modelResultBudget.current)
          return Promise.resolve('file contents')
        }
      }
    }
  }
}))

/** Consume the next scripted round, defaulting to a plain finished reply. */
function nextRound(): ScriptedRound {
  return mocks.rounds.shift() ?? {}
}

vi.mock('openai', () => {
  class APIUserAbortError extends Error {}
  class OpenAI {
    static AuthenticationError = class extends Error {}
    static NotFoundError = class extends Error {}
    responses = {
      stream: (request: Record<string, unknown>) => {
        mocks.openAiRequests.push(request)
        const round = nextRound()
        return {
          on: (event: string, handler: (payload: { delta: string }) => void) => {
            if (event === 'response.output_text.delta' && round.text) {
              handler({ delta: round.text })
            }
          },
          finalResponse: () => {
            if (round.error) return Promise.reject(round.error)
            return Promise.resolve({
              output: round.toolCall
                ? [
                    {
                      type: 'function_call',
                      call_id: `call-${mocks.openAiRequests.length}`,
                      name: 'read_file',
                      arguments: '{}'
                    }
                  ]
                : [],
              usage: { output_tokens: 1, input_tokens: round.inputTokens ?? 100 }
            })
          }
        }
      }
    }
    models = { retrieve: vi.fn() }
  }
  return { default: OpenAI, APIUserAbortError }
})

vi.mock('@anthropic-ai/sdk', () => {
  class APIUserAbortError extends Error {}
  class Anthropic {
    static AuthenticationError = class extends Error {}
    static NotFoundError = class extends Error {}
    messages = {
      stream: (request: Record<string, unknown>) => {
        mocks.anthropicRequests.push(request)
        const round = nextRound()
        return {
          response: null,
          on: (event: string, handler: (delta: string) => void) => {
            if (event === 'text' && round.text) handler(round.text)
          },
          once: vi.fn(),
          finalMessage: () => {
            if (round.error) return Promise.reject(round.error)
            return Promise.resolve({
              content: round.toolCall
                ? [
                    {
                      type: 'tool_use',
                      id: `tool-${mocks.anthropicRequests.length}`,
                      name: 'read_file',
                      input: {}
                    }
                  ]
                : [],
              stop_reason: round.toolCall ? 'tool_use' : 'end_turn',
              usage: { output_tokens: 1, input_tokens: round.inputTokens ?? 100 }
            })
          }
        }
      }
    }
    models = { retrieve: vi.fn() }
  }
  return { default: Anthropic, APIUserAbortError }
})

const { openAiProvider } = await import('../OpenAiProvider')
const { anthropicProvider } = await import('../AnthropicProvider')

/** `params.tools` only has to be truthy — `buildTools` is mocked out above. */
const withTools = { workspaceRoot: 'C:\\ws' } as unknown as GenerateParams['tools']

function params(overrides: Partial<GenerateParams> = {}): GenerateParams {
  return {
    conversationId: 'conversation',
    messageId: 'message',
    history: [],
    prompt: 'Audit the project.',
    onToken: vi.fn(),
    ...overrides
  }
}

const providers = [
  { name: 'OpenAI', generate: (p: GenerateParams) => openAiProvider.generate(p) },
  { name: 'Anthropic', generate: (p: GenerateParams) => anthropicProvider.generate(p) }
]

beforeEach(() => {
  mocks.rounds.length = 0
  mocks.openAiRequests.length = 0
  mocks.anthropicRequests.length = 0
  mocks.budgetsAtToolTime.length = 0
  mocks.toolContext = null
})

describe.each(providers)('$name provider round resilience', ({ generate }) => {
  it('bounds the first tool result before any usage has been reported', async () => {
    mocks.rounds.push({ toolCall: true }, { text: 'Done.' })

    await generate(params({ tools: withTools }))

    // Left null — as every cloud provider used to leave it permanently — a
    // single `read_file` can hand back 60 KB regardless of how full the turn is.
    const budget = mocks.budgetsAtToolTime[0]
    expect(budget).not.toBeNull()
    expect(budget?.maxTokensPerResult).toBeGreaterThan(0)
  })

  it('shrinks the result budget as the turn fills the window', async () => {
    mocks.rounds.push(
      { toolCall: true, inputTokens: 1_000 },
      { toolCall: true, inputTokens: 150_000 },
      { text: 'Done.' }
    )

    await generate(params({ tools: withTools }))

    const [early, late] = mocks.budgetsAtToolTime
    expect(early?.maxTokensPerResult).toBeGreaterThan(0)
    // The whole point: the cap tracks the room actually left, so a long agent
    // run cannot keep injecting full-size reads into a window it has used up.
    expect(late?.maxTokensPerResult).toBeLessThan(early?.maxTokensPerResult ?? 0)
  })

  it('separates the text of one round from the next', async () => {
    // A model that narrates before a tool call and answers after it produces
    // text in two bursts. Concatenated directly — which is what `content +=
    // delta` across rounds amounts to — the last word of one ran into the first
    // of the next: `Let me check the config.Found three problems.`
    mocks.rounds.push(
      { toolCall: true, text: 'Let me check the config.' },
      { text: 'Found three problems.' }
    )

    const outcome = await generate(params({ tools: withTools }))

    expect(outcome.content).toBe('Let me check the config.\n\nFound three problems.')
  })

  it('leaves a round that only called a tool out of the reply entirely', async () => {
    // The common case: no text at all before the call. A blank gap where that
    // round would have been is as wrong as a missing separator.
    mocks.rounds.push({ toolCall: true }, { text: 'Done.' })

    const outcome = await generate(params({ tools: withTools }))

    expect(outcome.content).toBe('Done.')
  })

  it('keeps the work of earlier rounds when a later one fails', async () => {
    mocks.rounds.push(
      { toolCall: true, text: 'Read the config. ' },
      { error: new Error('429 rate limit exceeded.') }
    )

    const outcome = await generate(params({ tools: withTools }))

    // Throwing here discarded the whole outcome, and `boundedChatRunner` has no
    // catch of its own — so a multi-cycle reply lost every earlier cycle too.
    // Trailing space gone: round text is now folded through `appendRoundText`,
    // which trims each round so a blank-line join between rounds is exact.
    expect(outcome.content).toBe('Read the config.')
    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('provider-error')
    // The provider's own message travels with it: a turn preserved after a rate
    // limit and one preserved after a malformed request are indistinguishable
    // without it, and call for opposite responses from the user.
    expect(outcome.stopDetail).toContain('429')
  })

  it('still throws when the very first round fails with nothing to keep', async () => {
    mocks.rounds.push({ error: new Error('Invalid API key.') })

    // Nothing was produced, so the error message is the entire value of the
    // turn — swallowing it would leave a blank reply and no explanation.
    await expect(generate(params({ tools: withTools }))).rejects.toThrow('Invalid API key.')
  })
})
