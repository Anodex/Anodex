import { describe, expect, it } from 'vitest'
import {
  RECOMMENDED_MODELS,
  inferModelFamily,
  recommendedModelFileName
} from '../recommendedModels'

describe('recommendedModelFileName', () => {
  it('extracts the filename from the download URL', () => {
    const model = RECOMMENDED_MODELS.find((m) => m.id === 'qwen2.5-coder-3b-q4')!
    expect(recommendedModelFileName(model)).toBe('qwen2.5-coder-3b-instruct-q4_k_m.gguf')
  })

  it('extracts a distinct filename for every recommended model', () => {
    const names = RECOMMENDED_MODELS.map(recommendedModelFileName)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name.toLowerCase().endsWith('.gguf')).toBe(true)
  })

  it('falls back to the model id when the URL has no recognizable .gguf filename', () => {
    const model = {
      id: 'weird-model',
      name: 'Weird',
      family: 'other' as const,
      tier: '3b' as const,
      description: '',
      approxSize: '',
      minRam: '',
      minRamGb: 0,
      downloadUrl: 'https://example.com/download?file=model',
      tags: []
    }
    expect(recommendedModelFileName(model)).toBe('weird-model.gguf')
  })
})

describe('catalog diversity', () => {
  it('includes more than one model family, not just Qwen', () => {
    const families = new Set(RECOMMENDED_MODELS.map((m) => m.family))
    expect(families.size).toBeGreaterThan(1)
    expect(families.has('qwen')).toBe(true)
  })

  it('gives every catalog entry a real, known family (never "other")', () => {
    for (const model of RECOMMENDED_MODELS) {
      expect(model.family).not.toBe('other')
    }
  })
})

describe('inferModelFamily', () => {
  it('detects each known family from a filename, case-insensitively', () => {
    expect(inferModelFamily('Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf')).toBe('qwen')
    expect(inferModelFamily('Meta-Llama-3.1-8B-Instruct.Q4_K_M.gguf')).toBe('meta')
    expect(inferModelFamily('Mistral-7B-Instruct-v0.3-Q4_K_M.gguf')).toBe('mistral')
    expect(inferModelFamily('Codestral-22B-v0.1-Q4_K_M.gguf')).toBe('mistral')
    expect(inferModelFamily('gemma-2-9b-it-Q4_K_M.gguf')).toBe('google')
    expect(inferModelFamily('DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf')).toBe('deepseek')
  })

  it('falls back to "other" for an unrecognized name', () => {
    expect(inferModelFamily('some-custom-finetune-v2.gguf')).toBe('other')
  })
})
