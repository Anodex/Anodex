import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerateParams } from '../../llama/LlamaService'

/**
 * `runChatCompletionsLoop` — the generation loop behind eight cloud vendors
 * plus Azure, and the largest untested surface in `src/main/llm`. These cover
 * what it puts on the wire and how it survives a tool misbehaving, neither of
 * which any suite touched before.
 */

interface ScriptedRound {
  toolCall?: { name: string; args: string }
  text?: string
}

const mocks = vi.hoisted(() => ({
  rounds: [] as ScriptedRound[],
  requests: [] as Array<Record<string, unknown>>,
  toolFunctions: {}
}))

vi.mock('openai', () => {
  class APIUserAbortError extends Error {}
  class OpenAI {
    static AuthenticationError = class extends Error {}
    static NotFoundError = class extends Error {}
    chat = {
      completions: {
        stream: (request: Record<string, unknown>) => {
          mocks.requests.push(request)
          const round = mocks.rounds.shift() ?? {}
          return {
            on: (event: string, handler: (delta: string) => void) => {
              if (event === 'content' && round.text) handler(round.text)
            },
            finalChatCompletion: () =>
              Promise.resolve({
                choices: [
                  {
                    message: {
                      content: round.text ?? null,
                      tool_calls: round.toolCall
                        ? [
                            {
                              id: `call-${mocks.requests.length}`,
                              type: 'function',
                              function: {
                                name: round.toolCall.name,
                                arguments: round.toolCall.args
                              }
                            }
                          ]
                        : []
                    }
                  }
                ],
                usage: { completion_tokens: 1, prompt_tokens: 100 }
              })
          }
        }
      }
    }
    models = { retrieve: vi.fn() }
  }
  return { default: OpenAI, APIUserAbortError }
})

vi.mock('../../tools/registry', () => ({ buildTools: () => mocks.toolFunctions }))

const { runChatCompletionsLoop } = await import('../OpenAiCompatibleProvider')
const OpenAI = (await import('openai')).default

/** `params.tools` only has to be truthy — `buildTools` is mocked out above. */
const withTools = { workspaceRoot: 'C:\\ws' } as unknown as GenerateParams['tools']

function params(overrides: Partial<GenerateParams> = {}): GenerateParams {
  return {
    conversationId: 'c1',
    messageId: 'm1',
    history: [],
    prompt: 'Search the project.',
    onToken: () => {},
    ...overrides
  }
}

function run(overrides: Partial<GenerateParams> = {}): ReturnType<typeof runChatCompletionsLoop> {
  return runChatCompletionsLoop(
    new OpenAI({ apiKey: 'k' }),
    'test-model',
    params(overrides),
    'openrouter'
  )
}

beforeEach(() => {
  mocks.rounds.length = 0
  mocks.requests.length = 0
  mocks.toolFunctions = {}
})

describe('runChatCompletionsLoop — tool schemas on the wire', () => {
  it('sends each tool’s own required list, leaving optional parameters optional', async () => {
    mocks.toolFunctions = {
      search_code: {
        description: 'Search.',
        params: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'number' } },
          required: ['query']
        },
        handler: () => Promise.resolve('ok')
      }
    }
    mocks.rounds.push({ text: 'Done.' })

    await run({ tools: withTools })

    const tools = mocks.requests[0].tools as Array<{
      function: { parameters: { required: string[]; properties: Record<string, unknown> } }
    }>
    // Marking every property required does not get better arguments out of a
    // model — it gets an invented `limit` instead of the documented default.
    expect(tools[0].function.parameters.required).toEqual(['query'])
    expect(Object.keys(tools[0].function.parameters.properties)).toEqual(['query', 'limit'])
  })

  it('omits the tools field entirely for a turn with no tools', async () => {
    mocks.rounds.push({ text: 'Done.' })

    await run()

    expect(mocks.requests[0].tools).toBeUndefined()
  })
})

describe('runChatCompletionsLoop — a tool misbehaving never breaks the turn', () => {
  it('reports an unknown tool back to the model instead of failing', async () => {
    mocks.toolFunctions = {
      real_tool: { description: 'Real.', params: {}, handler: () => Promise.resolve('ok') }
    }
    mocks.rounds.push({ toolCall: { name: 'ghost_tool', args: '{}' } })
    mocks.rounds.push({ text: 'Recovered.' })

    const outcome = await run({ tools: withTools })

    expect(outcome.content).toBe('Recovered.')
    const sent = mocks.requests[1].messages as Array<{ role: string; content: string }>
    expect(sent.at(-1)?.content).toContain('Unknown tool')
  })

  it('turns a thrown handler into a tool result rather than a failed turn', async () => {
    mocks.toolFunctions = {
      read_file: {
        description: 'Read.',
        params: {},
        handler: () => Promise.reject(new Error('ENOENT: no such file'))
      }
    }
    mocks.rounds.push({ toolCall: { name: 'read_file', args: '{}' } })
    mocks.rounds.push({ text: 'Handled it.' })

    const outcome = await run({ tools: withTools })

    expect(outcome.content).toBe('Handled it.')
    const sent = mocks.requests[1].messages as Array<{ role: string; content: string }>
    expect(sent.at(-1)?.content).toContain('ENOENT')
  })

  it('turns unparseable arguments into a tool result rather than a failed turn', async () => {
    const handler = vi.fn(() => Promise.resolve('ok'))
    mocks.toolFunctions = { read_file: { description: 'Read.', params: {}, handler } }
    mocks.rounds.push({ toolCall: { name: 'read_file', args: '{"path": "a.ts"' } })
    mocks.rounds.push({ text: 'Handled it.' })

    const outcome = await run({ tools: withTools })

    // The half-written call must never be repaired and run.
    expect(handler).not.toHaveBeenCalled()
    expect(outcome.content).toBe('Handled it.')
  })
})

describe('runChatCompletionsLoop — round budget', () => {
  it('does not run tools it has no remaining round to consume', async () => {
    const handler = vi.fn(() => Promise.resolve('ok'))
    mocks.toolFunctions = { read_file: { description: 'Read.', params: {}, handler } }
    mocks.rounds.push({ toolCall: { name: 'read_file', args: '{}' } })

    const outcome = await runChatCompletionsLoop(
      new OpenAI({ apiKey: 'k' }),
      'test-model',
      { ...params({ tools: withTools }), maxProviderRounds: 1 },
      'openrouter'
    )

    // Side effects that cannot influence a reply must not happen at all.
    expect(handler).not.toHaveBeenCalled()
    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('rounds-exhausted')
  })

  it('never sends two consecutive turns of the same role', async () => {
    // An assistant turn that errored or was stopped is still persisted into
    // history, and a turn with no text and no images is skipped when building
    // the request — leaving the two user turns either side of it adjacent.
    // Mistral and Google's compat layer have historically required strict
    // alternation, so that is a malformed request rather than a cosmetic one.
    mocks.rounds.push({ text: 'Fine.' })

    await run({
      history: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'second question' }
      ]
    })

    const sent = mocks.requests[0].messages as Array<{ role: string; content: unknown }>
    const roles = sent.map((message) => message.role)
    expect(roles.some((role, i) => i > 0 && role === roles[i - 1])).toBe(false)
    // Merged, not dropped: neither question is lost.
    const merged = sent.find(
      (message) =>
        typeof message.content === 'string' && String(message.content).includes('first question')
    )
    expect(String(merged?.content)).toContain('second question')
  })
})
