import { describe, it, expect } from 'vitest'
import { resolveModelContextSize } from '../modelContextSize'
import { createDefaultSettings } from '../settings.defaults'

const DEEPSEEK = String.raw`C:\models\DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf`
const QWEN = String.raw`C:\models\Qwen3.6-27B-Q4_K_M.gguf`

function settings(global: number, perModel: Record<string, number> = {}) {
  const defaults = createDefaultSettings(String.raw`C:\models`)
  return {
    ...defaults,
    model: { ...defaults.model, contextSize: global },
    modelContextSizes: perModel
  }
}

describe('resolveModelContextSize', () => {
  it('keeps a model at its own size when another model was sized down', () => {
    // The regression: sizing the 27B vision model to 8,192 wrote one global
    // number, and the coding model then loaded at 8,192 too.
    const saved = settings(8192, { [DEEPSEEK]: 16384, [QWEN]: 8192 })

    expect(resolveModelContextSize(saved, DEEPSEEK)).toBe(16384)
    expect(resolveModelContextSize(saved, QWEN)).toBe(8192)
  })

  it('falls back to the global setting for a model never sized deliberately', () => {
    expect(resolveModelContextSize(settings(16384), String.raw`C:\models\new.gguf`)).toBe(16384)
  })

  it('lets an explicit override win over both', () => {
    const saved = settings(16384, { [DEEPSEEK]: 16384 })
    expect(resolveModelContextSize(saved, DEEPSEEK, 4096)).toBe(4096)
  })

  it('returns undefined before settings have loaded, leaving the default to the engine', () => {
    expect(resolveModelContextSize(null, DEEPSEEK)).toBeUndefined()
    expect(resolveModelContextSize(undefined, DEEPSEEK)).toBeUndefined()
  })

  it('ignores a missing path rather than guessing', () => {
    expect(resolveModelContextSize(settings(16384, { [DEEPSEEK]: 4096 }), null)).toBe(16384)
  })
})
