import { describe, expect, it } from 'vitest'
import type { ModelLoadOptions } from '@shared/model.types'
import { describeLoad } from '../modelLoadKey'

const base: ModelLoadOptions = { path: '/models/qwen.gguf' }

/**
 * A second load for the same model waits for the first; a second load for
 * anything else is refused. This key is what decides which, so the cost of
 * getting it wrong is a caller silently receiving an engine configured the way
 * somebody else asked for.
 */
describe('describeLoad', () => {
  it('matches two requests for the same model with the same settings', () => {
    expect(describeLoad(base)).toBe(describeLoad({ path: '/models/qwen.gguf' }))
  })

  it('treats an omitted option as the same as an omitted option', () => {
    expect(describeLoad({ ...base, contextSize: undefined })).toBe(describeLoad(base))
  })

  it('separates a different model', () => {
    expect(describeLoad(base)).not.toBe(describeLoad({ path: '/models/llama.gguf' }))
  })

  it.each([
    ['context window', { contextSize: 65_536 }],
    ['GPU layers', { gpuLayers: 20 as const }],
    ['automatic GPU layers', { gpuLayers: 'auto' as const }],
    ['parallel jobs', { parallelJobs: 2 }],
    ['a vision projector', { visionProjectorPath: '/models/mmproj.gguf' }]
  ])('separates a request that differs by %s', (_label, difference) => {
    expect(describeLoad(base)).not.toBe(describeLoad({ ...base, ...difference }))
  })

  it('separates two different values of the same option', () => {
    expect(describeLoad({ ...base, contextSize: 8_192 })).not.toBe(
      describeLoad({ ...base, contextSize: 65_536 })
    )
  })

  it('does not confuse a set option with an unset one', () => {
    // '0' and unset are different requests, and JSON would render them alike
    // if either were coerced to a falsy default.
    expect(describeLoad({ ...base, parallelJobs: 0 })).not.toBe(describeLoad(base))
  })
})
