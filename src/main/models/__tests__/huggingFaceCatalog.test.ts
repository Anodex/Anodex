import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  estimateRamRequirements,
  estimateTier,
  extractQuant,
  fetchTopModels,
  inferPrimaryUse,
  inferSupportsTools,
  isSingleFileGguf,
  pickBestGgufFile,
  resetTopModelsCacheForTests,
  searchHuggingFaceModels
} from '../huggingFaceCatalog'

describe('isSingleFileGguf', () => {
  it('accepts a plain single-file GGUF', () => {
    expect(isSingleFileGguf('model-q4_k_m.gguf')).toBe(true)
  })

  it('rejects a multi-part split file', () => {
    expect(isSingleFileGguf('model-q4_k_m-00001-of-00004.gguf')).toBe(false)
  })

  it('rejects a non-GGUF file', () => {
    expect(isSingleFileGguf('README.md')).toBe(false)
  })
})

describe('extractQuant', () => {
  it('extracts a K-quant with a size suffix', () => {
    expect(extractQuant('qwen2.5-coder-7b-instruct-q4_k_m.gguf')).toBe('q4_k_m')
  })

  it('extracts a plain numbered quant', () => {
    expect(extractQuant('model-q5_0.gguf')).toBe('q5_0')
  })

  it('returns null for a filename with no recognizable quant', () => {
    expect(extractQuant('model-fp16.gguf')).toBeNull()
  })
})

describe('pickBestGgufFile', () => {
  it('prefers q4_k_m over other available quants', () => {
    const file = pickBestGgufFile([
      { rfilename: 'model-q8_0.gguf', size: 8_000_000_000 },
      { rfilename: 'model-q4_k_m.gguf', size: 4_000_000_000 },
      { rfilename: 'model-q5_0.gguf', size: 5_000_000_000 }
    ])
    expect(file?.rfilename).toBe('model-q4_k_m.gguf')
  })

  it('excludes multi-part files even if they would otherwise be preferred', () => {
    const file = pickBestGgufFile([
      { rfilename: 'model-q4_k_m-00001-of-00002.gguf', size: 2_000_000_000 },
      { rfilename: 'model-q4_k_m-00002-of-00002.gguf', size: 2_000_000_000 },
      { rfilename: 'model-q8_0.gguf', size: 8_000_000_000 }
    ])
    expect(file?.rfilename).toBe('model-q8_0.gguf')
  })

  it('excludes files with no known size', () => {
    const file = pickBestGgufFile([
      { rfilename: 'model-q4_k_m.gguf' },
      { rfilename: 'model-q8_0.gguf', size: 8_000_000_000 }
    ])
    expect(file?.rfilename).toBe('model-q8_0.gguf')
  })

  it('returns null when nothing usable is available', () => {
    expect(pickBestGgufFile([{ rfilename: 'model-q4_k_m-00001-of-00003.gguf', size: 1 }])).toBeNull()
  })

  it('falls back to the smallest file when no recognized quant matches', () => {
    const file = pickBestGgufFile([
      { rfilename: 'model-weird.gguf', size: 5_000_000_000 },
      { rfilename: 'model-other.gguf', size: 3_000_000_000 }
    ])
    expect(file?.rfilename).toBe('model-other.gguf')
  })
})

describe('estimateRamRequirements', () => {
  it('is generous enough to comfortably cover a real curated catalog entry', () => {
    // Qwen2.5 Coder 7B: real GGUF ~4.7 GB, real curated minRamGb is 16.
    const { minRamGb } = estimateRamRequirements(4.7 * 1024 ** 3)
    expect(minRamGb).toBeGreaterThan(0)
    expect(minRamGb).toBeLessThan(30) // sane bound, not wildly overestimating either
  })

  it('idealRamGb is always at least minRamGb', () => {
    const { minRamGb, idealRamGb } = estimateRamRequirements(10 * 1024 ** 3)
    expect(idealRamGb).toBeGreaterThanOrEqual(minRamGb)
  })
})

describe('estimateTier', () => {
  it('buckets a small file as 1b', () => {
    expect(estimateTier(0.8 * 1024 ** 3)).toBe('1b')
  })

  it('buckets a ~7B-class file as 7b', () => {
    expect(estimateTier(4.7 * 1024 ** 3)).toBe('7b')
  })

  it('buckets a ~32B-class file as 32b', () => {
    expect(estimateTier(20 * 1024 ** 3)).toBe('32b')
  })

  it('buckets a huge file as 70b', () => {
    expect(estimateTier(60 * 1024 ** 3)).toBe('70b')
  })
})

describe('inferSupportsTools', () => {
  it('trusts the Qwen family, based on this project own hands-on testing', () => {
    expect(inferSupportsTools('Qwen/Qwen3-Coder-30B-A3B-Instruct-GGUF', [])).toBe(true)
  })

  it('does not trust the DeepSeek family, per this project own testing', () => {
    expect(inferSupportsTools('bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF', [])).toBe(false)
  })

  it('does not trust the Mistral/Mixtral family, per this project own testing', () => {
    expect(inferSupportsTools('mistralai/Mistral-7B-Instruct-v0.3', [])).toBe(false)
  })

  it('picks up an explicit tool/function-calling tag for an unrecognized family', () => {
    expect(inferSupportsTools('some-org/some-model-GGUF', ['function-calling'])).toBe(true)
  })

  it('defaults to false when nothing suggests tool support', () => {
    expect(inferSupportsTools('some-org/some-model-GGUF', ['chat'])).toBe(false)
  })

  it('does not extend the Qwen Coder trust to a plain, untested Qwen model', () => {
    expect(inferSupportsTools('Qwen/Qwen2.5-0.5B-Instruct-GGUF', [])).toBe(false)
  })
})

describe('inferPrimaryUse', () => {
  it('detects coding models from the repo id', () => {
    expect(inferPrimaryUse('Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', [])).toBe('coding')
  })

  it('detects coding models from tags when the id does not mention it', () => {
    expect(inferPrimaryUse('some-org/some-model-GGUF', ['code', 'chat'])).toBe('coding')
  })

  it('defaults to general when nothing suggests coding', () => {
    expect(inferPrimaryUse('meta-llama/Llama-3.2-1B-Instruct-GGUF', ['chat'])).toBe('general')
  })
})

describe('searchHuggingFaceModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns an empty result without calling fetch for a blank query', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy
    const result = await searchHuggingFaceModels('   ')
    expect(result).toEqual({ ok: true, value: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('resolves search hits into downloadable RecommendedModel entries', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/models?')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              { id: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', downloads: 154325, likes: 311, tags: ['code'] }
            ])
        })
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
            gguf: { context_length: 131072 },
            siblings: [
              { rfilename: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf', size: 4_683_073_536 },
              { rfilename: 'qwen2.5-coder-7b-instruct-fp16.gguf', size: 15_000_000_000 }
            ]
          })
      })
    })

    const result = await searchHuggingFaceModels('qwen coder')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(1)
    const model = result.value[0]
    expect(model.source).toBe('huggingface')
    expect(model.repoId).toBe('Qwen/Qwen2.5-Coder-7B-Instruct-GGUF')
    expect(model.downloadUrl).toBe(
      'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf'
    )
    expect(model.primaryUse).toBe('coding')
    expect(model.hfDownloads).toBe(154325)
  })

  it('returns a friendly error when the search request itself fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))
    const result = await searchHuggingFaceModels('qwen')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('models.discover-failed')
  })

  it('skips a repo whose detail fetch fails, without dropping the rest', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/models?')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              { id: 'broken/repo', downloads: 1, likes: 0, tags: [] },
              { id: 'good/repo', downloads: 2, likes: 0, tags: [] }
            ])
        })
      }
      if (url.includes('broken/repo')) {
        return Promise.resolve({ ok: false, status: 500 })
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 'good/repo',
            siblings: [{ rfilename: 'good-model-q4_k_m.gguf', size: 4_000_000_000 }]
          })
      })
    })

    const result = await searchHuggingFaceModels('test')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(1)
    expect(result.value[0]?.repoId).toBe('good/repo')
  })

  it('skips a repo with no usable single-file GGUF', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/models?')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ id: 'split-only/repo', downloads: 1, likes: 0, tags: [] }])
        })
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 'split-only/repo',
            siblings: [
              { rfilename: 'model-q4_k_m-00001-of-00002.gguf', size: 2_000_000_000 },
              { rfilename: 'model-q4_k_m-00002-of-00002.gguf', size: 2_000_000_000 }
            ]
          })
      })
    })

    const result = await searchHuggingFaceModels('test')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(0)
  })
})

describe('fetchTopModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetTopModelsCacheForTests()
  })

  it('merges results across trusted publishers and resolves them like a search', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('author=Qwen')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct-GGUF', downloads: 200000, likes: 500, tags: [] }
            ])
        })
      }
      if (url.includes('author=')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct-GGUF',
            gguf: { context_length: 262144 },
            siblings: [{ rfilename: 'qwen3-coder-30b-a3b-instruct-q4_k_m.gguf', size: 18_000_000_000 }]
          })
      })
    })

    const result = await fetchTopModels()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(1)
    expect(result.value[0]?.repoId).toBe('Qwen/Qwen3-Coder-30B-A3B-Instruct-GGUF')
    expect(result.value[0]?.source).toBe('huggingface')
    // Qwen family — this project's own testing says it calls tools reliably.
    expect(result.value[0]?.supportsTools).toBe(true)
  })

  it('excludes embedding/feature-extraction repos even if a trusted publisher owns them', async () => {
    // Only the non-embedding hit's detail request should resolve to a model.
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('author=google')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                id: 'google/embeddinggemma-300m-GGUF',
                downloads: 999999,
                likes: 10,
                tags: ['feature-extraction'],
                pipeline_tag: 'feature-extraction'
              },
              { id: 'google/gemma-2-9b-it-GGUF', downloads: 500, likes: 5, tags: [] }
            ])
        })
      }
      if (url.includes('author=')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 'google/gemma-2-9b-it-GGUF',
            siblings: [{ rfilename: 'gemma-2-9b-it-q4_k_m.gguf', size: 5_800_000_000 }]
          })
      })
    })

    const result = await fetchTopModels()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(1)
    expect(result.value[0]?.repoId).toBe('google/gemma-2-9b-it-GGUF')
  })

  it('returns a friendly error when every publisher query fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))
    const result = await fetchTopModels()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('models.discover-failed')
  })

  it('returns a friendly error (not a crash) when no publisher has any hits', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) })
    const result = await fetchTopModels()
    expect(result.ok).toBe(false)
  })

  it('caches a successful result instead of re-fetching immediately', async () => {
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes('author=Qwen')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([{ id: 'Qwen/Some-Model-GGUF', downloads: 1, likes: 0, tags: [] }])
        })
      }
      if (url.includes('author=')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 'Qwen/Some-Model-GGUF',
            siblings: [{ rfilename: 'some-model-q4_k_m.gguf', size: 1_000_000_000 }]
          })
      })
    })
    globalThis.fetch = fetchSpy

    const first = await fetchTopModels()
    const callCountAfterFirst = fetchSpy.mock.calls.length
    const second = await fetchTopModels()
    expect(second).toEqual(first)
    expect(fetchSpy.mock.calls.length).toBe(callCountAfterFirst)
  })
})
