import { describe, expect, it, vi } from 'vitest'
import type { ChatRequest } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import { runGeneration, type RunGenerationIo, type RunGenerationResult } from '../runGeneration'
import { runBoundedChatGeneration } from '../boundedChatRunner'

vi.mock('../runGeneration', () => ({
  runGeneration: vi.fn()
}))

const mockedRunGeneration = vi.mocked(runGeneration)

function baseRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    conversationId: 'conv-1',
    messageId: 'msg-1',
    history: [],
    prompt: 'audit the project',
    ...overrides
  }
}

function baseIo(overrides: Partial<RunGenerationIo> = {}): RunGenerationIo {
  return {
    confirm: () => Promise.resolve({ approved: true }),
    ...overrides
  }
}

function result(overrides: Partial<RunGenerationResult> = {}): RunGenerationResult {
  return {
    content: '',
    stats: { tokens: 0, durationMs: 0, tokensPerSecond: 0 },
    stopped: false,
    ...overrides
  }
}

describe('runBoundedChatGeneration', () => {
  it('returns a single cycle unchanged when the turn finishes normally', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockResolvedValueOnce(
      result({ content: 'Done.', stats: { tokens: 10, durationMs: 100, tokensPerSecond: 100 } })
    )

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledOnce()
    expect(outcome.content).toBe('Done.')
    expect(outcome.stopped).toBe(false)
    expect(outcome.stats.tokens).toBe(10)
  })

  it('automatically continues after a recoverable stop that made real progress', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockResolvedValueOnce(
        result({
          content: 'Partial audit so far.',
          stopped: true,
          stopReason: 'token-limit',
          stats: { tokens: 100, durationMs: 1_000, tokensPerSecond: 100 }
        })
      )
      .mockResolvedValueOnce(
        result({
          content: 'Finished the audit.',
          stopped: false,
          stats: { tokens: 20, durationMs: 200, tokensPerSecond: 100 }
        })
      )

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledTimes(2)
    // Both cycles' visible text are stitched into one combined reply.
    expect(outcome.content).toBe('Partial audit so far.\n\nFinished the audit.')
    // Cross-cycle token/duration totals, not just the last cycle's own stats.
    expect(outcome.stats.tokens).toBe(120)
    expect(outcome.stats.durationMs).toBe(1_200)
    expect(outcome.stopped).toBe(false)

    // The second call continues the same turn: the first cycle's own
    // exchange is folded into history, and the prompt is a continuation
    // nudge, not a repeat of the original request.
    const secondCallArgs = mockedRunGeneration.mock.calls[1][0]
    expect(secondCallArgs.history).toEqual([
      { role: 'user', content: 'audit the project' },
      { role: 'assistant', content: 'Partial audit so far.' }
    ])
    expect(secondCallArgs.prompt).not.toBe('audit the project')
    expect(secondCallArgs.prompt.length).toBeGreaterThan(0)
  })

  it("carries this cycle's tool calls into the continuation history, not just its visible text", async () => {
    // Regression: a live retest showed a later cycle respond "I notice
    // there's no actual prior work in this conversation to continue from —
    // I need to start the architecture audit fresh," despite 30+ real tool
    // calls already having happened. Cause: a mid-turn session rebuild
    // (proactive/reactive compaction — see `LlamaService.ensureSession`)
    // replays the *explicit* `history` array from scratch, and an assistant
    // turn with no `toolCalls` carries no record of what was actually read —
    // only `ToolCall.result` does (see its doc comment in `tools.types.ts`).
    // Without this, every earlier cycle's tool work is invisible to the
    // model the moment any compaction happens to fire between cycles.
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'call-1',
          name: 'read_file_range',
          kind: 'read',
          title: 'Read src/index.ts',
          status: 'success',
          result: 'export const x = 1'
        })
        return Promise.resolve(
          result({
            content: 'Read the entry point.',
            stopped: true,
            stopReason: 'context-shift-limit',
            stats: { tokens: 40, durationMs: 400, tokensPerSecond: 100 }
          })
        )
      })
      .mockResolvedValueOnce(
        result({ content: 'Done.', stats: { tokens: 10, durationMs: 100, tokensPerSecond: 100 } })
      )

    await runBoundedChatGeneration(baseRequest(), baseIo())

    const secondCallArgs = mockedRunGeneration.mock.calls[1][0]
    const assistantTurn = secondCallArgs.history[1]
    expect(assistantTurn.toolCalls).toHaveLength(1)
    expect(assistantTurn.toolCalls?.[0]).toMatchObject({
      id: 'call-1',
      name: 'read_file_range',
      result: 'export const x = 1'
    })
  })

  it('continues progress via a real tool call even when no visible text streamed yet', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration
      .mockImplementationOnce((_request, io: RunGenerationIo) => {
        io.onActivity?.({
          id: 'call-1',
          name: 'read_file_range',
          kind: 'read',
          title: 'Read src/index.ts',
          status: 'success'
        })
        return Promise.resolve(
          result({
            content: '',
            stopped: true,
            stopReason: 'tool-limit',
            stats: { tokens: 50, durationMs: 500, tokensPerSecond: 100 }
          })
        )
      })
      .mockResolvedValueOnce(
        result({
          content: 'Here is the audit.',
          stats: { tokens: 30, durationMs: 300, tokensPerSecond: 100 }
        })
      )

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledTimes(2)
    // The first cycle produced no visible text (only a tool call), so the
    // combined reply isn't padded with a leading blank line for it.
    expect(outcome.content).toBe('Here is the audit.')
  })

  it('does not continue after a recoverable stop that made no real progress', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockResolvedValueOnce(
      result({
        content: '',
        stopped: true,
        stopReason: 'token-limit',
        stats: { tokens: 5, durationMs: 50, tokensPerSecond: 100 }
      })
    )

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledOnce()
    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('token-limit')
  })

  it('does not continue after a non-recoverable stop, even with progress', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockResolvedValueOnce(
      result({
        content: 'Some real work happened.',
        stopped: true,
        stopReason: 'fixed-context-limit',
        stats: { tokens: 5, durationMs: 50, tokensPerSecond: 100 }
      })
    )

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    expect(mockedRunGeneration).toHaveBeenCalledOnce()
    expect(outcome.stopReason).toBe('fixed-context-limit')
  })

  it('does not continue once a real user Stop occurred', async () => {
    mockedRunGeneration.mockReset()
    const controller = new AbortController()
    mockedRunGeneration.mockImplementationOnce(() => {
      controller.abort()
      return Promise.resolve(
        result({
          content: 'Interrupted mid-audit.',
          stopped: true,
          stopReason: 'token-limit',
          stats: { tokens: 5, durationMs: 50, tokensPerSecond: 100 }
        })
      )
    })

    const outcome = await runBoundedChatGeneration(
      baseRequest(),
      baseIo({ signal: controller.signal })
    )

    expect(mockedRunGeneration).toHaveBeenCalledOnce()
    expect(outcome.stopped).toBe(true)
  })

  it('caps the number of cycles even when every cycle keeps making progress', async () => {
    mockedRunGeneration.mockReset()
    mockedRunGeneration.mockImplementation(() =>
      Promise.resolve(
        result({
          content: 'more work',
          stopped: true,
          stopReason: 'tool-limit',
          stats: { tokens: 1, durationMs: 1, tokensPerSecond: 1 }
        })
      )
    )

    const outcome = await runBoundedChatGeneration(baseRequest(), baseIo())

    // 5 cycles total (MAX_CYCLES): every one reported recoverable + progress,
    // so only the hard cycle cap itself ends the loop.
    expect(mockedRunGeneration).toHaveBeenCalledTimes(5)
    expect(outcome.stopped).toBe(true)
    expect(outcome.stopReason).toBe('tool-limit')
  })

  it('forwards a later cycle onActivity/onToken through to the caller-supplied io', async () => {
    mockedRunGeneration.mockReset()
    const seenActivity: ToolCall[] = []
    mockedRunGeneration.mockResolvedValueOnce(
      result({ content: 'Done.', stats: { tokens: 1, durationMs: 1, tokensPerSecond: 1 } })
    )

    await runBoundedChatGeneration(
      baseRequest(),
      baseIo({ onActivity: (call) => seenActivity.push(call) })
    )

    // Drive the mocked call's io directly to prove the wrapper composes with,
    // rather than replaces, the caller's own onActivity.
    const [, io] = mockedRunGeneration.mock.calls[0]
    io.onActivity?.({
      id: 'call-1',
      name: 'list_directory',
      kind: 'read',
      title: 'List .',
      status: 'success'
    })

    expect(seenActivity).toHaveLength(1)
    expect(seenActivity[0].name).toBe('list_directory')
  })
})
