import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from '@shared/model.types'
import type { GenerateParams } from '../LlamaService'

/**
 * Tests for the llama-server (vision) transport.
 *
 * This path had no coverage at all despite being what *every* local model with
 * a multimodal projector runs on — text-only chats included, since
 * `LlamaService.generateInternal` routes the whole turn here the moment
 * `visionService.active` is true.
 *
 * Several cases pin behavior that a live failure proved was missing: recovery
 * from a tool call cut off mid-arguments, an output ceiling measured against
 * the real tokenizer, and the fabrication/fallback mitigations the text path
 * has always had. Treat them as regression guards, not implementation detail.
 */

interface StreamChunk {
  choices?: Array<{
    finish_reason?: string | null
    delta: {
      content?: string
      reasoning_content?: string
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
  usage?: { completion_tokens?: number }
}

const mocks = vi.hoisted(() => ({
  /**
   * One entry per round: either chunks to stream, or an error to throw.
   * `elapsedMs` advances the mocked clock for that round, so a test can say
   * how long the request "took" — the service distinguishes a real generation
   * from a runtime replaying a stale failure by exactly that.
   */
  rounds: [] as Array<{
    chunks?: StreamChunk[]
    error?: Error
    elapsedMs?: number
    /** New llama-server output this request produces, i.e. the runtime really ran. */
    emitsRuntimeOutput?: string
  }>,
  /** Mocked `Date.now()`, advanced only by scripted round durations. */
  now: 0,
  requests: [] as Array<Record<string, unknown>>,
  toolFunctions: {},
  /**
   * Stands in for llama-server's `/tokenize`. `null` models a runtime that
   * cannot measure (older build, transport failure); the default is a rough
   * 1-token-per-4-characters rule so counts move with the input.
   */
  countTokens: null as ((text: string) => number | null) | null,
  reliability: [] as unknown[][],
  toolContext: null as {
    emit: (call: unknown) => void
    modelResultBudget: { current: unknown }
  } | null,
  /**
   * Stands in for the tail of llama-server's own stdout. The service compares
   * it across a request to tell a runtime that really ran the model (new
   * per-request accounting printed) from one replaying a cached failure
   * (byte-identical output), so a test can script either.
   */
  runtimeOutput: 'slot released | stop type = limit'
}))

class FakeApiError extends Error {}
class FakeAbortError extends Error {}

vi.mock('openai', () => {
  class FakeOpenAI {
    chat = {
      completions: {
        create: (body: Record<string, unknown>) => {
          mocks.requests.push(body)
          const round = mocks.rounds.shift()
          if (!round) throw new Error('No scripted round left for this request.')
          // Default to a duration only a real generation could take, so a test
          // has to opt in to the implausibly-fast case.
          mocks.now += round.elapsedMs ?? 60_000
          if (round.emitsRuntimeOutput) mocks.runtimeOutput = round.emitsRuntimeOutput
          if (round.error) throw round.error
          const chunks = round.chunks ?? []
          return Promise.resolve({
            [Symbol.asyncIterator]: function* () {
              for (const chunk of chunks) yield chunk
            }
          })
        }
      }
    }
  }
  return { default: FakeOpenAI, APIUserAbortError: FakeAbortError }
})

vi.mock('../LlamaServerRuntime', () => ({
  LlamaServerRuntime: class {
    activeConnection: unknown = {
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'test-key',
      modelId: 'test-model'
    }
    start(): Promise<unknown> {
      return Promise.resolve(this.activeConnection)
    }
    stop(): Promise<void> {
      return Promise.resolve()
    }
    settleExit(): Promise<void> {
      return Promise.resolve()
    }
    describeUnexpectedStop(): undefined {
      return undefined
    }
    countTokens(text: string): Promise<number | null> {
      return Promise.resolve(
        mocks.countTokens ? mocks.countTokens(text) : Math.ceil(text.length / 4)
      )
    }
    recentOutput(): string {
      return mocks.runtimeOutput
    }
  }
}))

vi.mock('../../tools/registry', () => ({
  // Captures the runtime context so a test's handler can emit tool activity
  // the way `runGuardedTool` does for every real tool.
  buildTools: (_define: unknown, ctx: NonNullable<(typeof mocks)['toolContext']>) => {
    mocks.toolContext = ctx
    return mocks.toolFunctions
  }
}))

vi.mock('../../models/ModelReliabilityStore', () => ({
  modelReliabilityStore: {
    recordToolCall: (...args: unknown[]) => mocks.reliability.push(['tool', ...args]),
    recordFabrication: (...args: unknown[]) => mocks.reliability.push(['fabrication', ...args])
  }
}))

const { LlamaVisionService } = await import('../LlamaVisionService')

function textChunk(content: string, finish?: string | null): StreamChunk {
  return { choices: [{ delta: { content }, finish_reason: finish ?? null }] }
}

function toolCallChunk(name: string, args: string, id = 'call_1'): StreamChunk {
  return {
    choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }]
  }
}

function params(overrides: Partial<GenerateParams> = {}): GenerateParams {
  return {
    conversationId: 'c_test',
    messageId: 'm_test',
    systemPrompt: 'You are Anodex.',
    history: [],
    prompt: 'Build a website.',
    onToken: () => {},
    ...overrides
  }
}

/** `params.tools` only has to be truthy — `buildTools` is mocked out above. */
const withTools = { workspaceRoot: 'C:\\ws' } as unknown as GenerateParams['tools']

const TEST_MODEL: ModelInfo = {
  id: 'model-1',
  name: 'Test 27B',
  path: 'C:\\models\\test-27b.gguf',
  sizeBytes: 1,
  source: 'local'
}

async function service(contextSize?: number): Promise<InstanceType<typeof LlamaVisionService>> {
  const instance = new LlamaVisionService(undefined, () => TEST_MODEL)
  await instance.load({ path: 'model.gguf', visionProjectorPath: 'mmproj.gguf', contextSize })
  return instance
}

beforeEach(() => {
  mocks.rounds.length = 0
  mocks.requests.length = 0
  mocks.toolFunctions = {}
  mocks.countTokens = null
  mocks.reliability.length = 0
  mocks.now = 0
  mocks.runtimeOutput = 'slot released | stop type = limit'
  vi.spyOn(Date, 'now').mockImplementation(() => mocks.now)
})

describe('LlamaVisionService.generate', () => {
  it('streams visible tokens and returns the assembled reply', async () => {
    mocks.rounds.push({ chunks: [textChunk('Hello '), textChunk('world.', 'stop')] })
    const tokens: string[] = []

    const outcome = await (await service()).generate(params({ onToken: (t) => tokens.push(t) }))

    expect(tokens).toEqual(['Hello ', 'world.'])
    expect(outcome.content).toBe('Hello world.')
    expect(outcome.stopped).toBe(false)
  })

  it('separates reasoning tokens from the visible reply', async () => {
    mocks.rounds.push({
      chunks: [
        { choices: [{ delta: { reasoning_content: 'thinking...' } }] },
        textChunk('Answer.', 'stop')
      ]
    })
    const thinking: string[] = []

    const outcome = await (
      await service()
    ).generate(params({ onThinkingToken: (t) => thinking.push(t) }))

    expect(thinking).toEqual(['thinking...'])
    expect(outcome.content).toBe('Answer.')
    expect(outcome.thinking).toBe('thinking...')
  })

  it('runs a tool call and feeds its result back for the next round', async () => {
    const handler = vi.fn(() => Promise.resolve('wrote 42 bytes'))
    mocks.toolFunctions = {
      write_file: {
        description: 'Write a file.',
        params: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content']
        },
        handler
      }
    }
    mocks.rounds.push({ chunks: [toolCallChunk('write_file', '{"path":"a.txt","content":"hi"}')] })
    mocks.rounds.push({ chunks: [textChunk('Done.', 'stop')] })

    const outcome = await (await service()).generate(params({ tools: withTools }))

    expect(handler).toHaveBeenCalledWith({ path: 'a.txt', content: 'hi' })
    expect(outcome.content).toBe('Done.')
    const followUp = mocks.requests[1].messages as Array<Record<string, unknown>>
    expect(followUp.at(-1)).toMatchObject({ role: 'tool', content: 'wrote 42 bytes' })
  })

  it('never executes a handler when the model emits unparseable arguments', async () => {
    const handler = vi.fn(() => Promise.resolve('should not run'))
    mocks.toolFunctions = {
      write_file: { description: 'Write a file.', params: { type: 'object' }, handler }
    }
    // A tool call whose argument string was cut off mid-value.
    mocks.rounds.push({ chunks: [toolCallChunk('write_file', '{"path":"a.txt","content":"<html')] })
    mocks.rounds.push({ chunks: [textChunk('Sorry.', 'stop')] })

    await (await service()).generate(params({ tools: withTools }))

    expect(handler).not.toHaveBeenCalled()
    const followUp = mocks.requests[1].messages as Array<Record<string, unknown>>
    expect(followUp.at(-1)).toMatchObject({
      role: 'tool',
      content: 'Tool "write_file" received invalid JSON arguments.'
    })
  })

  it('reports a token-limit stop', async () => {
    mocks.rounds.push({ chunks: [textChunk('Cut off here', 'length')] })

    const outcome = await (await service()).generate(params())

    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('token-limit')
  })

  it('reports a rounds-exhausted stop rather than looping forever', async () => {
    mocks.toolFunctions = {
      read_file: {
        description: 'Read.',
        params: { type: 'object' },
        handler: () => Promise.resolve('ok')
      }
    }
    mocks.rounds.push({ chunks: [toolCallChunk('read_file', '{}')] })
    mocks.rounds.push({ chunks: [toolCallChunk('read_file', '{}')] })

    const outcome = await (
      await service()
    ).generate(params({ tools: withTools, maxProviderRounds: 2 }))

    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('rounds-exhausted')
  })

  it('treats an aborted signal as a user stop, not a failure', async () => {
    const controller = new AbortController()
    controller.abort()
    mocks.rounds.push({ error: new FakeAbortError('aborted') })

    const outcome = await (await service()).generate(params({ signal: controller.signal }))

    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('user')
  })

  // ---------------------------------------------------------------------------
  // Recovery from a tool call that was cut off before its arguments finished.
  // This is the failure that lost an entire 11-minute turn: llama-server parses
  // the arguments itself and answers HTTP 500 when they are unterminated.
  // ---------------------------------------------------------------------------

  /** The exact shape llama.cpp returns, abbreviated. */
  function truncatedToolCall(): Error {
    return new FakeApiError(
      '500 Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] ' +
        'parse error at line 1, column 4909: syntax error while parsing value - invalid string: ' +
        'missing closing quote; last read: \'"<!DOCTYPE html>\\n<html lang=\\"en\\">'
    )
  }

  it('recovers from a truncated tool call and lets the model finish the turn', async () => {
    mocks.toolFunctions = {
      write_file: {
        description: 'Write.',
        params: { type: 'object' },
        handler: () => Promise.resolve('ok')
      }
    }
    mocks.rounds.push({ error: truncatedToolCall() })
    mocks.rounds.push({ chunks: [textChunk('Wrote it in pieces instead.', 'stop')] })

    const outcome = await (await service()).generate(params({ tools: withTools }))

    expect(outcome.content).toBe('Wrote it in pieces instead.')
    expect(outcome.stopped).toBe(false)
    expect(mocks.requests).toHaveLength(2)
  })

  it('tells the model the call did not run and asks for a smaller one', async () => {
    mocks.toolFunctions = {
      write_file: {
        description: 'Write.',
        params: { type: 'object' },
        handler: () => Promise.resolve('ok')
      }
    }
    mocks.rounds.push({ error: truncatedToolCall() })
    mocks.rounds.push({ chunks: [textChunk('ok', 'stop')] })

    await (await service()).generate(params({ tools: withTools }))

    const followUp = mocks.requests[1].messages as Array<{ role: string; content: string }>
    const guidance = followUp.at(-1)
    expect(guidance?.role).toBe('user')
    expect(guidance?.content).toContain('cut off')
    expect(guidance?.content).toContain('Nothing was written')
    expect(guidance?.content).toContain('Do not repeat that call as-is')
  })

  it('never repairs and runs the partial arguments', async () => {
    const handler = vi.fn(() => Promise.resolve('ok'))
    mocks.toolFunctions = {
      write_file: { description: 'Write.', params: { type: 'object' }, handler }
    }
    mocks.rounds.push({ error: truncatedToolCall() })
    mocks.rounds.push({ chunks: [textChunk('ok', 'stop')] })

    await (await service()).generate(params({ tools: withTools }))

    // Closing the dangling string would have written a half-finished file and
    // reported success. A visible failure is the correct outcome instead.
    expect(handler).not.toHaveBeenCalled()
  })

  it('stops immediately when the failure came back too fast to have generated', async () => {
    mocks.toolFunctions = {
      write_file: {
        description: 'Write.',
        params: { type: 'object' },
        handler: () => Promise.resolve('ok')
      }
    }
    // Reproduces what a live run showed: one real 58-second truncation, then
    // byte-identical failures returning in 23 ms and 16 ms. Those retries
    // never ran the model, so spending the budget on them only ends the turn
    // on a message wrongly blaming the size of the request.
    mocks.rounds.push({ error: truncatedToolCall(), elapsedMs: 58_000 })
    mocks.rounds.push({ error: truncatedToolCall(), elapsedMs: 23 })
    mocks.rounds.push({ error: truncatedToolCall(), elapsedMs: 16 })

    const failure = await (
      await service()
    )
      .generate(params({ tools: withTools }))
      .catch((e: Error) => e)

    expect((failure as Error).message).toMatch(/Reload the model/)
    // One genuine attempt plus one retry that proved the runtime was stuck.
    expect(mocks.requests).toHaveLength(2)
  })

  it('gives up with an actionable stop reason rather than retrying forever', async () => {
    mocks.toolFunctions = {
      write_file: {
        description: 'Write.',
        params: { type: 'object' },
        handler: () => Promise.resolve('ok')
      }
    }
    for (let i = 0; i < 5; i++) mocks.rounds.push({ error: truncatedToolCall() })

    const outcome = await (await service()).generate(params({ tools: withTools }))

    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('tool-call-truncated')
    // Two recoveries, then it stops — a slow model must not burn the turn.
    expect(mocks.requests).toHaveLength(3)
  })

  // ---------------------------------------------------------------------------
  // Mitigations ported from the node-llama-cpp text path, which this transport
  // silently did without — every multimodal model lost all of them.
  // ---------------------------------------------------------------------------

  it('runs a tool call the model printed as prose instead of invoking', async () => {
    const handler = vi.fn(() => Promise.resolve('listed 3 files'))
    mocks.toolFunctions = {
      list_directory: { description: 'List.', params: { type: 'object' }, handler }
    }
    mocks.rounds.push({
      chunks: [
        textChunk(
          'Let me look.\n<tool_call>{"name":"list_directory","arguments":{"path":"."}}</tool_call>'
        )
      ]
    })
    mocks.rounds.push({ chunks: [textChunk('Three files.', 'stop')] })

    const outcome = await (await service()).generate(params({ tools: withTools }))

    expect(handler).toHaveBeenCalledWith({ path: '.' })
    // The raw call text is stripped from the reply; the commentary survives.
    expect(outcome.content).toContain('Let me look.')
    expect(outcome.content).not.toContain('tool_call')
  })

  it('nudges once when the model claims work it never did', async () => {
    mocks.toolFunctions = {
      write_file: {
        description: 'Write.',
        params: { type: 'object' },
        handler: () => Promise.resolve('ok')
      }
    }
    mocks.rounds.push({ chunks: [textChunk("I've added the function to the file.")] })
    mocks.rounds.push({ chunks: [textChunk('You are right, I did not.', 'stop')] })

    const outcome = await (await service()).generate(params({ tools: withTools }))

    const secondRequest = mocks.requests[1].messages as Array<{ role: string; content: string }>
    expect(secondRequest.at(-1)?.content).toBe(
      'You described an outcome — a change, an approval, or a denial — that did not ' +
        'actually happen this turn; no tool was called. If you intend to make the change, ' +
        "call the appropriate tool now to do it for real. If you can't or the task " +
        "is blocked, say so plainly instead of describing something that didn't happen."
    )
    expect(outcome.fabricationDetected).toBe(true)
  })

  it('nudges at most once per turn', async () => {
    mocks.toolFunctions = {
      write_file: {
        description: 'Write.',
        params: { type: 'object' },
        handler: () => Promise.resolve('ok')
      }
    }
    // Claims completion three times running; only the first earns a retry.
    for (let i = 0; i < 3; i++) {
      mocks.rounds.push({ chunks: [textChunk("I've updated the file.", i === 2 ? 'stop' : null)] })
    }

    await (await service()).generate(params({ tools: withTools }))

    expect(mocks.requests).toHaveLength(2)
  })

  it('records tool outcomes and fabrications against the loaded model', async () => {
    mocks.toolFunctions = {
      write_file: {
        description: 'Write.',
        params: { type: 'object' },
        handler: () => Promise.resolve('ok')
      }
    }
    mocks.rounds.push({ chunks: [textChunk("I've created the file.")] })
    mocks.rounds.push({ chunks: [textChunk('Sorry.', 'stop')] })

    await (await service()).generate(params({ tools: withTools }))

    expect(mocks.reliability).toContainEqual([
      'fabrication',
      'model-1',
      'Test 27B',
      'test-27b.gguf'
    ])
  })

  it('does not flag a truthful report made in the same turn as a real tool call', async () => {
    mocks.toolFunctions = {
      write_file: {
        description: 'Write.',
        params: { type: 'object' },
        handler: () => {
          mocks.toolContext?.emit({ name: 'write_file', kind: 'write', status: 'success' })
          return Promise.resolve('ok')
        }
      }
    }
    mocks.rounds.push({ chunks: [toolCallChunk('write_file', '{"path":"a.txt"}')] })
    mocks.rounds.push({ chunks: [textChunk("I've created the file.", 'stop')] })

    const outcome = await (await service()).generate(params({ tools: withTools }))

    expect(outcome.fabricationDetected).toBeUndefined()
    expect(mocks.reliability.some(([kind]) => kind === 'fabrication')).toBe(false)
  })

  it('reports a truncated call in plain language when there are no tools to retry with', async () => {
    mocks.rounds.push({ error: truncatedToolCall() })

    // The raw nlohmann text used to be surfaced here and persisted into the
    // conversation JSON — several kilobytes of C++ parser output in a chat bubble.
    const failure = await (await service()).generate(params()).catch((e: Error) => e)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/cut off part-way/)
    expect((failure as Error).message).not.toMatch(/json\.exception|DOCTYPE/)
  })

  it("sends each tool's own required list, leaving optional parameters optional", async () => {
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
    mocks.rounds.push({ chunks: [textChunk('ok', 'stop')] })

    await (await service()).generate(params({ tools: withTools }))

    const tools = mocks.requests[0].tools as Array<{ function: { parameters: unknown } }>
    expect(tools[0].function.parameters).toMatchObject({ required: ['query'] })
  })

  it('clamps max_tokens to the room a measured prompt actually leaves', async () => {
    mocks.toolFunctions = {
      write_file: {
        description: 'Write.',
        params: { type: 'object' },
        handler: () => Promise.resolve('ok')
      }
    }
    // 30k of a 32,768 context already spent: far less than 8,192 is left. The
    // context has to be loaded at that size for the fixture to mean anything —
    // against the 8,192 default those 30k tokens do not fit at all, and the
    // turn is now stopped before a doomed request rather than clamped.
    mocks.countTokens = (text) => (text.includes('Build a website.') ? 30_000 : 10)
    mocks.rounds.push({ chunks: [textChunk('ok', 'stop')] })

    const outcome = await (
      await service(32_768)
    ).generate(params({ tools: withTools, options: { maxTokens: 8192 } }))

    const sent = mocks.requests[0].max_tokens as number
    expect(sent).toBeLessThan(8192)
    expect(sent).toBeGreaterThan(0)
    expect(outcome.contextBudget?.requestedMaxOutputTokens).toBe(8192)
    expect(outcome.contextBudget?.effectiveMaxOutputTokens).toBe(sent)
  })

  it('leaves the requested ceiling alone when the runtime cannot tokenize', async () => {
    mocks.toolFunctions = {
      write_file: {
        description: 'Write.',
        params: { type: 'object' },
        handler: () => Promise.resolve('ok')
      }
    }
    // The regression this guards: clamping against a guess would truncate
    // replies on any runtime without `/tokenize`, which is the very failure
    // the budget exists to prevent.
    mocks.countTokens = () => null
    mocks.rounds.push({ chunks: [textChunk('ok', 'stop')] })

    const outcome = await (
      await service()
    ).generate(params({ tools: withTools, options: { maxTokens: 8192 } }))

    expect(mocks.requests[0].max_tokens).toBe(8192)
    expect(outcome.contextBudget?.effectiveMaxOutputTokens).toBe(8192)
  })

  it('re-measures each round so a growing transcript keeps shrinking the ceiling', async () => {
    mocks.toolFunctions = {
      read_file: {
        description: 'Read.',
        params: { type: 'object' },
        handler: () => Promise.resolve('x'.repeat(4000))
      }
    }
    mocks.countTokens = (text) => Math.ceil(text.length / 4)
    mocks.rounds.push({ chunks: [toolCallChunk('read_file', '{}')] })
    mocks.rounds.push({ chunks: [textChunk('Done.', 'stop')] })

    await (await service()).generate(params({ tools: withTools, options: { maxTokens: 8192 } }))

    const first = mocks.requests[0].max_tokens as number
    const second = mocks.requests[1].max_tokens as number
    expect(second).toBeLessThan(first)
  })

  // ---------------------------------------------------------------------------
  // Context accounting. Every case here traces to one live failure: a turn
  // measured at 11,849 fixed tokens was given 3,420 more of output while
  // llama-server reported the real prompt reaching 16,383 of a 16,384 context.
  // The gap was the arguments of the tool calls already made that turn, which
  // the measurement scored as zero.
  // ---------------------------------------------------------------------------

  it('counts the arguments of tool calls already made this turn', async () => {
    mocks.toolFunctions = {
      write_file: {
        description: 'Write.',
        params: { type: 'object' },
        // Tiny, so the drop measured below can only come from the call itself.
        handler: () => Promise.resolve('ok')
      }
    }
    mocks.countTokens = (text) => Math.ceil(text.length / 4)
    // A `write_file` carrying a file body — the payload lives in the call's
    // arguments, and the assistant message that replays it has no `content` at
    // all. Measuring `content` alone scored this whole thing as zero and went
    // on to promise the model output room the context did not have.
    const fileBody = JSON.stringify({ path: 'index.html', content: 'x'.repeat(8_000) })
    mocks.rounds.push({ chunks: [toolCallChunk('write_file', fileBody)] })
    mocks.rounds.push({ chunks: [textChunk('Done.', 'stop')] })

    // No requested ceiling, so `max_tokens` is purely what the measurement says
    // is left — which is the number this test is about.
    await (await service(32_768)).generate(params({ tools: withTools }))

    const first = mocks.requests[0].max_tokens as number
    const second = mocks.requests[1].max_tokens as number
    // ~8,000 characters of arguments is ~2,000 tokens under this tokenizer.
    // Before the fix the drop was only the 2-character result.
    expect(first - second).toBeGreaterThan(1_500)
  })

  it('charges for images the tokenizer cannot see', async () => {
    mocks.countTokens = (text) => Math.ceil(text.length / 4)
    mocks.rounds.push({ chunks: [textChunk('A red circle.', 'stop')] })
    mocks.rounds.push({ chunks: [textChunk('A red circle.', 'stop')] })

    const image = {
      dataUrl: 'data:image/png;base64,aGk=',
      mimeType: 'image/png',
      name: 'shot.png',
      path: 'C:\\ws\\shot.png',
      sizeBytes: 2
    }
    const withoutImage = await (await service(32_768)).generate(params())
    const withImage = await (await service(32_768)).generate(params({ images: [image] }))

    // `/tokenize` takes text only, so a projector's embedding cost is invisible
    // to it. Left at zero it inflates the output ceiling by exactly the amount
    // most likely to run the real prompt past the end of the context.
    expect(withImage.contextBudget?.fixedTokens).toBeGreaterThan(
      (withoutImage.contextBudget?.fixedTokens ?? 0) + 500
    )
  })

  it('bounds tool results against the room the turn actually has left', async () => {
    mocks.toolFunctions = {
      read_file: {
        description: 'Read.',
        params: { type: 'object' },
        handler: () => Promise.resolve('ok')
      }
    }
    mocks.countTokens = (text) => Math.ceil(text.length / 4)
    mocks.rounds.push({ chunks: [textChunk('Done.', 'stop')] })

    await (await service(16_384)).generate(params({ tools: withTools }))

    // Left unset — as this transport used to leave it permanently — every tool
    // result falls back to a static character cap that knows nothing about how
    // much of the context is already spent.
    const budget = mocks.toolContext?.modelResultBudget.current as {
      contextSizeTokens: number
      maxTokensPerResult: number
    } | null
    expect(budget).not.toBeNull()
    expect(budget?.contextSizeTokens).toBe(16_384)
    expect(budget?.maxTokensPerResult).toBeGreaterThan(0)
  })

  it('ends the turn instead of sending a request the prompt has outgrown', async () => {
    mocks.toolFunctions = {
      read_file: {
        description: 'Read.',
        params: { type: 'object' },
        handler: () => Promise.resolve('y'.repeat(60_000))
      }
    }
    mocks.countTokens = (text) => Math.ceil(text.length / 4)
    mocks.rounds.push({ chunks: [toolCallChunk('read_file', '{}')] })
    mocks.rounds.push({ chunks: [textChunk('unreachable', 'stop')] })

    const outcome = await (await service(8_192)).generate(params({ tools: withTools }))

    // Sending it anyway is what produced the live failure: llama-server
    // truncates the prompt to fit, cuts the model off part-way through
    // whatever it was emitting, then 500s on its own parse of the fragment.
    expect(mocks.requests).toHaveLength(1)
    expect(outcome.stopped).toBe(true)
    // This turn's own tool traffic filled the window, which a fresh cycle over
    // compacted history can carry on from — so a recoverable stop.
    expect(outcome.stopReason).toBe('context-limit')
  })

  it('separates fixed input that never fit from a window this turn filled', async () => {
    // Nothing has accumulated on round 0, so the system prompt, project rules
    // and tool schemas are what do not fit. Continuing cannot help, and
    // reporting it as the recoverable `context-limit` would send the user after
    // the wrong thing — and let a caller retry a turn that can never start.
    mocks.countTokens = () => 9_000
    mocks.rounds.push({ chunks: [textChunk('unreachable', 'stop')] })

    const outcome = await (await service(8_192)).generate(params({ tools: withTools }))

    expect(mocks.requests).toHaveLength(0)
    expect(outcome.stopReason).toBe('fixed-context-limit')
  })

  it('reclaims room from earlier results without orphaning a tool call', async () => {
    let call = 0
    mocks.toolFunctions = {
      read_file: {
        description: 'Read.',
        params: { type: 'object' },
        handler: () => Promise.resolve(`${'z'.repeat(20_000)}#${(call += 1)}`)
      }
    }
    mocks.countTokens = (text) => Math.ceil(text.length / 4)
    for (let i = 0; i < 4; i++) {
      mocks.rounds.push({ chunks: [toolCallChunk('read_file', '{}', `call_${i}`)] })
    }
    mocks.rounds.push({ chunks: [textChunk('Done.', 'stop')] })

    const outcome = await (await service(16_384)).generate(params({ tools: withTools }))

    expect(outcome.content).toBe('Done.')
    const sent = mocks.requests.at(-1)?.messages as Array<{
      role: string
      content: unknown
      tool_call_id?: string
      tool_calls?: Array<{ id: string }>
    }>
    // The bulk is shed from results the model has already acted on...
    const trimmed = sent.filter(
      (m) => typeof m.content === 'string' && m.content.includes('[Result trimmed')
    )
    expect(trimmed.length).toBeGreaterThan(0)
    // ...in the smallest increment that buys room. The first tier keeps the
    // head of each result — the path, the match count, the opening lines are
    // the load-bearing part — rather than going straight to a bare stub.
    expect(String(trimmed[0].content).startsWith('z'.repeat(400))).toBe(true)
    // ...but every call still has its reply. An assistant `tool_calls` message
    // whose `role: 'tool'` answer went missing is a malformed exchange that
    // chat templates render inconsistently or refuse outright.
    const answered = new Set(sent.filter((m) => m.role === 'tool').map((m) => m.tool_call_id))
    for (const message of sent) {
      for (const made of message.tool_calls ?? []) expect(answered.has(made.id)).toBe(true)
    }
  })

  it('escalates only as far as it must to make the prompt fit', async () => {
    mocks.toolFunctions = {
      read_file: {
        description: 'Read.',
        params: { type: 'object' },
        // ~10k tokens each: two of them together overrun a 16k context, so no
        // tier that protects the newest *two* can fit this turn. The last tier —
        // which drops to protecting only the newest — is the one thing standing
        // between this and a `context-limit` stop.
        handler: () => Promise.resolve('z'.repeat(40_000))
      }
    }
    mocks.countTokens = (text) => Math.ceil(text.length / 4)
    for (let i = 0; i < 3; i++) {
      mocks.rounds.push({ chunks: [toolCallChunk('read_file', '{}', `call_${i}`)] })
    }
    mocks.rounds.push({ chunks: [textChunk('Done.', 'stop')] })

    const outcome = await (await service(16_384)).generate(params({ tools: withTools }))

    expect(outcome.content).toBe('Done.')
    expect(outcome.stopReason).toBeUndefined()
    const sent = mocks.requests.at(-1)?.messages as Array<{ role: string; content: unknown }>
    const results = sent.filter((m) => m.role === 'tool').map((m) => String(m.content))
    // Everything but the newest result gave up its body; the newest is intact,
    // because that is the one the model is still working from.
    expect(results.at(-1)?.length).toBe(40_000)
    expect(results.slice(0, -1).every((r) => r.startsWith('[Result trimmed'))).toBe(true)
  })

  it('treats a fast truncation as real when the runtime actually ran', async () => {
    mocks.toolFunctions = {
      write_file: {
        description: 'Write.',
        params: { type: 'object' },
        handler: () => Promise.resolve('ok')
      }
    }
    // A call cut off almost immediately — because the prompt left only a
    // handful of tokens — comes back just as fast as a replayed failure.
    // Timing alone cannot tell them apart, and calling this one a runtime fault
    // turns a recoverable round into a dead turn with misleading advice.
    // llama-server printing new per-request accounting is what settles it.
    mocks.rounds.push({
      error: truncatedToolCall(),
      elapsedMs: 40,
      emitsRuntimeOutput: 'slot launch_slot_: id 0 | task 7 | processing task'
    })
    mocks.rounds.push({ chunks: [textChunk('Wrote it in pieces instead.', 'stop')] })

    const outcome = await (await service()).generate(params({ tools: withTools }))

    expect(outcome.content).toBe('Wrote it in pieces instead.')
    expect(mocks.requests).toHaveLength(2)
  })

  it('keeps the work of earlier rounds when the runtime stalls late in a turn', async () => {
    mocks.toolFunctions = {
      write_file: {
        description: 'Write.',
        params: { type: 'object' },
        handler: () => Promise.resolve('ok')
      }
    }
    mocks.rounds.push({ chunks: [textChunk('Step 1 done. '), toolCallChunk('write_file', '{}')] })
    mocks.rounds.push({ error: truncatedToolCall(), elapsedMs: 58_000 })
    mocks.rounds.push({ error: truncatedToolCall(), elapsedMs: 16 })

    const outcome = await (await service()).generate(params({ tools: withTools }))

    // Throwing here discarded the whole outcome: the user saw a bare red error
    // while the files this turn had already written sat on disk, recorded
    // against no message at all.
    expect(outcome.content).toBe('Step 1 done. ')
    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('runtime-stalled')
  })
})
