import { describe, expect, it } from 'vitest'
import { contextSizeUpdate } from '../contextSizeUpdate'

describe('contextSizeUpdate', () => {
  // The half that exists because of a real bug: without the per-model entry the
  // chosen size silently followed the next model into the engine, because
  // `resolveModelContextSize` reads the per-model entry before the global one.
  it('records the size against the model it was chosen for', () => {
    const update = contextSizeUpdate({ contextSize: 16384 }, 'C:/models/qwen-4b.gguf')

    expect(update.modelContextSizes).toEqual({ 'C:/models/qwen-4b.gguf': 16384 })
  })

  it('also updates the global default, so the control and the next load agree', () => {
    const update = contextSizeUpdate({ contextSize: 16384 }, 'C:/models/qwen-4b.gguf')

    expect(update.model).toEqual({ contextSize: 16384 })
  })

  it('carries the rest of the patch through untouched', () => {
    const update = contextSizeUpdate(
      { contextSize: 32768, gpuLayers: 24, autoConfigured: true },
      'C:/models/x.gguf'
    )

    expect(update.model).toEqual({ contextSize: 32768, gpuLayers: 24, autoConfigured: true })
    expect(update.modelContextSizes).toEqual({ 'C:/models/x.gguf': 32768 })
  })

  // A cloud model has no path to key an entry on. Writing one under an empty
  // key would match nothing and accumulate silently, which is worse than not
  // writing it.
  it('writes no per-model entry when there is no local model', () => {
    const update = contextSizeUpdate({ contextSize: 8192 }, null)

    expect(update.model).toEqual({ contextSize: 8192 })
    expect(update.modelContextSizes).toBeUndefined()
  })

  it('keeps each model on its own size', () => {
    const first = contextSizeUpdate({ contextSize: 8192 }, 'C:/models/small.gguf')
    const second = contextSizeUpdate({ contextSize: 65536 }, 'C:/models/large.gguf')

    expect(first.modelContextSizes).toEqual({ 'C:/models/small.gguf': 8192 })
    expect(second.modelContextSizes).toEqual({ 'C:/models/large.gguf': 65536 })
  })
})
