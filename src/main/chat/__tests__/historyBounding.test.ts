import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineState } from '@shared/model.types'
import type { RunGenerationIo } from '../runGeneration'

/**
 * Which transports get their history bounded before a turn is sent.
 *
 * The dividing line is statefulness, not local-vs-cloud. Only the
 * node-llama-cpp engine keeps a session that compacts internally; everything
 * else re-sends the whole conversation each request. The local llama-server
 * transport sits on the "stateless" side despite `provider.active === 'local'`,
 * and reading the old `!== 'local'` check as "is it a cloud provider" is what
 * left it character-truncating its history with no summary for as long as it
 * existed.
 */

const mocks = vi.hoisted(() => ({
  engineState: {} as EngineState
}))

vi.mock('../../llama/LlamaService', () => ({
  llamaService: {
    getState: () => mocks.engineState,
    summarizeForCompactionLocal: () => Promise.resolve('summary')
  }
}))

const { resolveHistoryBounding } = await import('../runGeneration')

const io = {} as RunGenerationIo

beforeEach(() => {
  mocks.engineState = { status: 'ready', generating: false }
})

describe('resolveHistoryBounding', () => {
  it('leaves the node-llama-cpp engine to compact inside its own session', () => {
    mocks.engineState = { status: 'ready', generating: false, contextSize: 32_768, vision: false }

    expect(resolveHistoryBounding('local', null, io)).toBeNull()
  })

  it('bounds the local llama-server transport, which has no session to compact in', () => {
    mocks.engineState = { status: 'ready', generating: false, contextSize: 32_768, vision: true }

    const bounding = resolveHistoryBounding('local', null, io)

    expect(bounding?.contextWindowTokens).toBe(32_768)
    expect(bounding?.summarize).toBeTypeOf('function')
  })

  it('sizes the local summary chunk against the real context, not the cloud budget', () => {
    mocks.engineState = { status: 'ready', generating: false, contextSize: 4_096, vision: true }
    const small = resolveHistoryBounding('local', null, io)

    mocks.engineState = { status: 'ready', generating: false, contextSize: 32_768, vision: true }
    const large = resolveHistoryBounding('local', null, io)

    // Cloud-sized chunks would overflow the very call meant to relieve the
    // overflow on a small context.
    expect(small!.summaryChunkTokenBudget).toBeLessThan(large!.summaryChunkTokenBudget)
  })

  it('does nothing when no model is loaded to report a context size', () => {
    mocks.engineState = { status: 'unloaded', generating: false, vision: true }

    expect(resolveHistoryBounding('local', null, io)).toBeNull()
  })

  it('still bounds cloud providers against their own context window', () => {
    const bounding = resolveHistoryBounding('anthropic', { id: 'claude-sonnet-5' }, io)

    expect(bounding?.contextWindowTokens).toBeGreaterThan(0)
    expect(bounding?.summarize).toBeTypeOf('function')
  })

  it('skips a cloud provider with no resolved model', () => {
    expect(resolveHistoryBounding('anthropic', null, io)).toBeNull()
  })
})
