import { describe, expect, it } from 'vitest'
import { describeRunProvenance } from '../runProvenance'

describe('describeRunProvenance', () => {
  // Every one of 43 stored runs recorded `model: null`, because for a local run
  // the model is "whatever is loaded". Six models were compared in a single day
  // and the record cannot say which run used which, so every before/after
  // comparison drawn from it was confounded and always would be.
  it('records the local model and the window it ran at', () => {
    const provenance = describeRunProvenance('local', {
      lastModelPath: 'C:\\models\\Qwen3.8-27B-UD-Q4_K_M.gguf',
      modelContextSizes: { 'C:\\models\\Qwen3.8-27B-UD-Q4_K_M.gguf': 65536 },
      model: { contextSize: 8192 }
    } as never)

    expect(provenance).toEqual({ model: 'Qwen3.8-27B-UD-Q4_K_M', contextSize: 65536 })
  })

  it('strips the path and the extension, so runs group by model', () => {
    const a = describeRunProvenance('local', {
      lastModelPath: '/home/me/models/gemma-3-27b-it-Q4_K_M.gguf',
      modelContextSizes: {},
      model: { contextSize: 65536 }
    } as never)

    expect(a?.model).toBe('gemma-3-27b-it-Q4_K_M')
  })

  it('falls back to the global context size when the model has no remembered one', () => {
    const provenance = describeRunProvenance('local', {
      lastModelPath: '/models/x.gguf',
      modelContextSizes: {},
      model: { contextSize: 32768 }
    } as never)

    expect(provenance?.contextSize).toBe(32768)
  })

  // A cloud run's model is already recorded in `model`, and its window is the
  // provider's business, so there is nothing to add.
  it('says nothing for a cloud provider', () => {
    expect(describeRunProvenance('anthropic', { lastModelPath: '/m.gguf' } as never)).toBeNull()
  })

  it('says nothing when no model is loaded', () => {
    expect(describeRunProvenance('local', { modelContextSizes: {} } as never)).toBeNull()
  })
})
