import { describe, expect, it } from 'vitest'
import { shouldSizeForModel } from '../modelContextAutoSize'

const settings = (modelContextSizes: Record<string, number> = {}) => ({
  model: { contextSize: 8192, gpuLayers: 'auto' as const, parallelJobs: 1, autoConfigured: true },
  modelContextSizes
})

describe('shouldSizeForModel', () => {
  it('sizes a model that has never had a size of its own', () => {
    // The roadmap's case: the first launch sized 8,192 for the model it
    // recommended, and a model added later inherited it.
    expect(
      shouldSizeForModel({
        settings: settings(),
        modelPath: 'C:/models/new.gguf',
        requestedContextSize: 8192,
        hasVisionProjector: false
      })
    ).toBe(true)
  })

  it('keeps a size somebody chose for this model', () => {
    expect(
      shouldSizeForModel({
        settings: settings({ 'C:/models/new.gguf': 4096 }),
        modelPath: 'C:/models/new.gguf',
        requestedContextSize: 4096,
        hasVisionProjector: false
      })
    ).toBe(false)
  })

  it('gives a caller that names its own size exactly that', () => {
    expect(
      shouldSizeForModel({
        settings: settings(),
        modelPath: 'C:/models/new.gguf',
        requestedContextSize: 16384,
        hasVisionProjector: false
      })
    ).toBe(false)
  })

  it('sizes a load that named no size at all', () => {
    expect(
      shouldSizeForModel({
        settings: settings(),
        modelPath: 'C:/models/new.gguf',
        requestedContextSize: undefined,
        hasVisionProjector: false
      })
    ).toBe(true)
  })

  it('leaves vision models on the global size', () => {
    // The per-file figure does not count the projector's memory.
    expect(
      shouldSizeForModel({
        settings: settings(),
        modelPath: 'C:/models/vision.gguf',
        requestedContextSize: 8192,
        hasVisionProjector: true
      })
    ).toBe(false)
  })
})
