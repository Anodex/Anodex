import { describe, expect, it } from 'vitest'
import {
  inferModelFamily,
  recommendedModelFileName,
  recommendedVisionProjectorFileName
} from '../recommendedModels'
import { CATALOG_FIXTURE } from './fixtures/catalog'

describe('recommendedModelFileName', () => {
  it('extracts the filename from the download URL', () => {
    const model = CATALOG_FIXTURE.find((m) => m.id === 'qwen2.5-coder-3b-q4')!
    expect(recommendedModelFileName(model)).toBe('qwen2.5-coder-3b-instruct-q4_k_m.gguf')
  })

  it('extracts a distinct filename for every recommended model', () => {
    const names = CATALOG_FIXTURE.map(recommendedModelFileName)
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

describe('recommendedVisionProjectorFileName', () => {
  it('strips directory traversal from a supplied projector filename', () => {
    const model = {
      ...CATALOG_FIXTURE[0],
      visionProjectorUrl: 'https://example.com/mmproj-F16.gguf',
      visionProjectorFileName: '..\\outside.gguf'
    }

    expect(recommendedVisionProjectorFileName(model)).toBe('outside.gguf')
  })
})

/**
 * The "catalog diversity" cases that were here asserted that Anodex's own
 * twelve-model list covered more than one family. There is no such list any
 * more — the pool comes from Hugging Face at runtime — so the property they
 * guarded now belongs to `buildRecommendedSlots`, which will not give two
 * slots to the same family. That is covered in `scoring.test.ts`.
 */
describe('inferModelFamily', () => {
  it('detects each known family from a filename, case-insensitively', () => {
    expect(inferModelFamily('Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf')).toBe('qwen')
    expect(inferModelFamily('Meta-Llama-3.1-8B-Instruct.Q4_K_M.gguf')).toBe('meta')
    expect(inferModelFamily('Mistral-7B-Instruct-v0.3-Q4_K_M.gguf')).toBe('mistral')
    expect(inferModelFamily('Codestral-22B-v0.1-Q4_K_M.gguf')).toBe('mistral')
    expect(inferModelFamily('gemma-2-9b-it-Q4_K_M.gguf')).toBe('google')
    expect(inferModelFamily('DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf')).toBe('deepseek')
    expect(inferModelFamily('Phi-4-Q4_K_S.gguf')).toBe('microsoft')
  })

  it('falls back to "other" for an unrecognized name', () => {
    expect(inferModelFamily('some-custom-finetune-v2.gguf')).toBe('other')
  })
})
