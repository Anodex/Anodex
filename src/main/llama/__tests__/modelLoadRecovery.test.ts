import { describe, expect, it } from 'vitest'
import type { InterruptedModelLoad } from '@shared/model.types'
import { MIN_RECOVERY_CONTEXT, recoveryFor, reducedContext } from '../modelLoadRecovery'

function interrupted(overrides: Partial<InterruptedModelLoad> = {}): InterruptedModelLoad {
  return {
    modelPath: 'C:\\models\\qwen.gguf',
    modelName: 'Qwen 14B',
    gpuLayers: 'auto',
    contextSize: 16384,
    vision: false,
    startedAt: '2026-07-30T10:00:00.000Z',
    ...overrides
  }
}

describe('reducedContext', () => {
  it('halves a comfortable context', () => {
    expect(reducedContext(16384)).toBe(8192)
  })

  it('refuses to go below the floor', () => {
    expect(reducedContext(MIN_RECOVERY_CONTEXT * 2 - 2)).toBeNull()
    expect(reducedContext(MIN_RECOVERY_CONTEXT)).toBeNull()
  })

  it('has nothing to reduce when no size was requested', () => {
    expect(reducedContext(undefined)).toBeNull()
  })
})

describe('recoveryFor', () => {
  it('drops GPU offload first when it was on', () => {
    const recovery = recoveryFor(interrupted({ gpuLayers: 'auto' }))
    expect(recovery.retry.gpuLayers).toBe(0)
    expect(recovery.alreadyCpuOnly).toBe(false)
  })

  it('keeps the context size when only the GPU is suspect', () => {
    const recovery = recoveryFor(interrupted({ gpuLayers: 20, contextSize: 16384 }))
    expect(recovery.retry).toEqual({ gpuLayers: 0, contextSize: 16384 })
  })

  it('shrinks the context once offload is already off', () => {
    const recovery = recoveryFor(interrupted({ gpuLayers: 0, contextSize: 16384 }))
    expect(recovery.alreadyCpuOnly).toBe(true)
    expect(recovery.retry).toEqual({ gpuLayers: 0, contextSize: 8192 })
    expect(recovery.retryLabel).toContain('8,192')
  })

  it('stops proposing changes when CPU-only at a floor context still crashed', () => {
    const load = interrupted({ gpuLayers: 0, contextSize: MIN_RECOVERY_CONTEXT })
    const recovery = recoveryFor(load)
    expect(recovery.retry).toEqual({ gpuLayers: 0, contextSize: MIN_RECOVERY_CONTEXT })
    expect(recovery.explanation).toContain('corrupt')
  })

  // The floor case above is the one deliberate exception — there it says so
  // rather than dressing an identical retry up as a fix.
  it('changes something whenever a lever is left to pull', () => {
    for (const gpuLayers of ['auto', 0, 33] as const) {
      const load = interrupted({ gpuLayers, contextSize: 32768 })
      const recovery = recoveryFor(load)
      const unchanged =
        recovery.retry.gpuLayers === load.gpuLayers &&
        recovery.retry.contextSize === load.contextSize
      expect(unchanged).toBe(false)
    }
  })

  it('names the model in the headline and carries the original through', () => {
    const load = interrupted({ modelName: 'Gemma 4' })
    const recovery = recoveryFor(load)
    expect(recovery.headline).toContain('Gemma 4')
    expect(recovery.interrupted).toBe(load)
  })
})
