import { describe, expect, it, vi } from 'vitest'
import type { RunGenerationResult } from '../../chat/runGeneration'
import { addStats, runStructuredPhase, signalStopReason } from '../criticalThinkingStructuredPhase'

const STATS = (tokens: number, durationMs: number) => ({
  tokens,
  durationMs,
  tokensPerSecond: durationMs > 0 ? tokens / (durationMs / 1000) : 0
})

function generation(
  content: string,
  overrides: Partial<RunGenerationResult> = {}
): RunGenerationResult {
  return { content, stats: STATS(10, 1_000), stopped: false, ...overrides }
}

describe('runStructuredPhase', () => {
  it('accepts a valid artifact on a normal, unstopped completion', async () => {
    const result = await runStructuredPhase('prompt', new AbortController().signal, {
      generate: () => Promise.resolve(generation('{"ok":true}')),
      parse: (content) => ({ value: JSON.parse(content) as { ok: boolean }, valid: true })
    })

    expect(result.value).toEqual({ ok: true })
    expect(result.valid).toBe(true)
    expect(result.userStopped).toBe(false)
  })

  it('accepts a valid artifact even when the provider stopped for a recoverable reason', async () => {
    const result = await runStructuredPhase('prompt', new AbortController().signal, {
      generate: () =>
        Promise.resolve(generation('{"ok":true}', { stopped: true, stopReason: 'token-limit' })),
      parse: (content) => ({ value: JSON.parse(content) as { ok: boolean }, valid: true })
    })

    expect(result.value).toEqual({ ok: true })
    expect(result.valid).toBe(true)
    expect(result.userStopped).toBe(false)
    expect(result.stopReason).toBe('token-limit')
  })

  it('discards a syntactically valid artifact when the user genuinely stopped the phase', async () => {
    const controller = new AbortController()
    const parse = vi.fn()

    const result = await runStructuredPhase('prompt', controller.signal, {
      generate: () => {
        controller.abort('user')
        return Promise.resolve(generation('{"ok":true}', { stopped: true }))
      },
      parse
    })

    expect(result.value).toBeNull()
    expect(result.valid).toBe(false)
    expect(result.userStopped).toBe(true)
    // Parsing a discarded artifact is wasted work — the phase must skip it.
    expect(parse).not.toHaveBeenCalled()
  })

  it('runs exactly one bounded repair attempt and returns the repaired artifact', async () => {
    const generate = vi
      .fn<(prompt: string) => Promise<RunGenerationResult>>()
      .mockResolvedValueOnce(generation('not json'))
      .mockResolvedValueOnce(generation('{"ok":true}'))
    const buildRepairPrompt = vi.fn(
      (_previous: string, issues: string[]) => `repair: ${issues.join(', ')}`
    )

    const result = await runStructuredPhase('prompt', new AbortController().signal, {
      generate,
      parse: (content) =>
        content === '{"ok":true}'
          ? { value: { ok: true }, valid: true }
          : { value: null, valid: false, issues: ['not valid JSON'] },
      buildRepairPrompt
    })

    expect(generate).toHaveBeenCalledTimes(2)
    expect(buildRepairPrompt).toHaveBeenCalledWith('not json', ['not valid JSON'])
    expect(generate).toHaveBeenNthCalledWith(2, 'repair: not valid JSON')
    expect(result.value).toEqual({ ok: true })
    expect(result.valid).toBe(true)
  })

  it('combines stats across the original attempt and the repair attempt', async () => {
    const generate = vi
      .fn<(prompt: string) => Promise<RunGenerationResult>>()
      .mockResolvedValueOnce(generation('not json', { stats: STATS(10, 1_000) }))
      .mockResolvedValueOnce(generation('{"ok":true}', { stats: STATS(20, 1_000) }))

    const result = await runStructuredPhase('prompt', new AbortController().signal, {
      generate,
      parse: (content) =>
        content === '{"ok":true}'
          ? { value: { ok: true }, valid: true }
          : { value: null, valid: false },
      buildRepairPrompt: () => 'repair'
    })

    expect(result.stats.tokens).toBe(30)
    expect(result.stats.durationMs).toBe(2_000)
  })

  it('never repairs when the first attempt was stopped by the user', async () => {
    const controller = new AbortController()
    const generate = vi
      .fn<(prompt: string) => Promise<RunGenerationResult>>()
      .mockImplementation(() => {
        controller.abort('user')
        return Promise.resolve(generation('not json', { stopped: true }))
      })
    const buildRepairPrompt = vi.fn()

    await runStructuredPhase('prompt', controller.signal, {
      generate,
      parse: () => ({ value: null, valid: false }),
      buildRepairPrompt
    })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(buildRepairPrompt).not.toHaveBeenCalled()
  })

  it('never repairs after an orchestration-level stop', async () => {
    const generate = vi.fn().mockResolvedValue(
      generation('not json', {
        stopped: true,
        stopReason: 'yielded'
      })
    )
    const buildRepairPrompt = vi.fn()

    const result = await runStructuredPhase('prompt', new AbortController().signal, {
      generate,
      parse: () => ({ value: null, valid: false }),
      buildRepairPrompt
    })

    expect(result.stopReason).toBe('yielded')
    expect(generate).toHaveBeenCalledTimes(1)
    expect(buildRepairPrompt).not.toHaveBeenCalled()
  })

  it('does not repair when no repair prompt builder is configured', async () => {
    const generate = vi.fn().mockResolvedValue(generation('not json'))

    const result = await runStructuredPhase('prompt', new AbortController().signal, {
      generate,
      parse: () => ({ value: null, valid: false, issues: ['bad'] })
    })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(result.valid).toBe(false)
    expect(result.issues).toEqual(['bad'])
  })
})

describe('signalStopReason', () => {
  it('returns the fallback reason when the signal was never aborted', () => {
    expect(signalStopReason(new AbortController().signal, 'token-limit')).toBe('token-limit')
    expect(signalStopReason(undefined, undefined)).toBeUndefined()
  })

  it('reports time-limit when the signal was aborted for that reason, regardless of fallback', () => {
    const controller = new AbortController()
    controller.abort('time-limit')
    expect(signalStopReason(controller.signal, 'token-limit')).toBe('time-limit')
  })

  it('falls back to the provider reason, or "user", when aborted for any other reason', () => {
    const controller = new AbortController()
    controller.abort('user')
    expect(signalStopReason(controller.signal, undefined)).toBe('user')
    expect(signalStopReason(controller.signal, 'yielded')).toBe('yielded')
  })
})

describe('addStats', () => {
  it('sums tokens and duration and recomputes throughput', () => {
    const combined = addStats(STATS(10, 1_000), STATS(20, 1_000))
    expect(combined).toEqual({ tokens: 30, durationMs: 2_000, tokensPerSecond: 15 })
  })

  it('treats a null current as zero', () => {
    expect(addStats(null, STATS(5, 500))).toEqual({
      tokens: 5,
      durationMs: 500,
      tokensPerSecond: 10
    })
  })
})
