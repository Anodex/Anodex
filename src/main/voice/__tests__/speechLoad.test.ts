import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Deciding where to run the speech.
 *
 * The rule exists because of one measurement: the same sentence took 0.98 s to
 * generate with the graphics card free and 5.22 s with a chat model on it, and
 * in that second case running on the CPU instead was *faster* than offloading.
 * Queuing behind the chat model is the worst of the available choices, and it
 * was the one that shipped.
 */

const state = vi.fn<() => unknown>()

vi.mock('../../llama/LlamaService', () => ({
  llamaService: {
    getState: () => state()
  }
}))

const { planSpeechLoad, ON_A_FREE_GPU, BESIDE_A_CHAT_MODEL } = await import('../speechLoad')

beforeEach(() => {
  state.mockReturnValue({ status: 'idle', gpuLayersUsed: 0 })
})

describe('where a reply gets spoken', () => {
  it('takes the graphics card when nothing else is using it', () => {
    expect(planSpeechLoad()).toEqual(ON_A_FREE_GPU)
    expect(ON_A_FREE_GPU.gpuLayers).toBe(99)
  })

  it('stays off the card when the chat model is on it', () => {
    state.mockReturnValue({ status: 'ready', gpuLayersUsed: 40 })
    const plan = planSpeechLoad()
    expect(plan).toEqual(BESIDE_A_CHAT_MODEL)
    expect(plan.gpuLayers).toBe(0)
    // More at once, because the CPU is the idle resource in exactly this case.
    expect(plan.concurrency).toBeGreaterThan(ON_A_FREE_GPU.concurrency)
  })

  it('takes the card back when the chat model is running on the CPU', () => {
    // A loaded model is not the question — occupying the card is. A model with
    // no layers offloaded leaves the GPU free and Arc should use it.
    state.mockReturnValue({ status: 'ready', gpuLayersUsed: 0 })
    expect(planSpeechLoad()).toEqual(ON_A_FREE_GPU)
  })

  it('takes the card while a model is still loading', () => {
    // Not ready means not generating. This is the honest reading of a status
    // that is neither idle nor in use.
    state.mockReturnValue({ status: 'loading', gpuLayersUsed: 40 })
    expect(planSpeechLoad()).toEqual(ON_A_FREE_GPU)
  })

  it('does not fail if the engine cannot be asked', () => {
    // Called from a voice path that must not be able to break chat, or itself.
    state.mockImplementation(() => {
      throw new Error('no engine')
    })
    expect(() => planSpeechLoad()).not.toThrow()
    expect(planSpeechLoad()).toEqual(ON_A_FREE_GPU)
  })

  it('says which case it chose', () => {
    // Written into the log line for a reading, so a slow one can be explained
    // later without reproducing it.
    expect(ON_A_FREE_GPU.reason).toMatch(/free/)
    expect(BESIDE_A_CHAT_MODEL.reason).toMatch(/busy/)
  })
})
