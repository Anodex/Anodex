import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  estimateRamRequirements,
  estimateTier,
  extractQuant,
  fetchTopModels,
  inferPrimaryUse,
  inferSupportsTools,
  templateHandlesTools,
  isSingleFileGguf,
  pickBestGgufFile,
  pickVisionProjector,
  isRecommendableRepo,
  resetTopModelsCacheForTests,
  searchHuggingFaceModels,
  uptakeRate
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
    expect(
      pickBestGgufFile([{ rfilename: 'model-q4_k_m-00001-of-00003.gguf', size: 1 }])
    ).toBeNull()
  })

  it('falls back to the largest file when no recognized quant matches', () => {
    // The model is the big file. What repositories publish beside it — draft
    // heads, projectors, adapters — is always smaller, so "smallest" reliably
    // picked something that is not the model.
    const file = pickBestGgufFile([
      { rfilename: 'model-ud-q4_k_xl.gguf', size: 5_000_000_000 },
      { rfilename: 'model-extra.gguf', size: 3_000_000_000 }
    ])
    expect(file?.rfilename).toBe('model-ud-q4_k_xl.gguf')
  })

  it('never offers a draft head as the model', () => {
    // `unsloth/gemma-4-12B-it-qat-GGUF`, as published: Anodex offered its 242MB
    // multi-token-prediction module as "gemma-4-12B" in 0.4 GB.
    const file = pickBestGgufFile([
      { rfilename: 'MTP/mtp-gemma-4-12B-it-Q4_0.gguf', size: 254_000_000 },
      { rfilename: 'mtp-gemma-4-12B-it.gguf', size: 254_000_000 },
      { rfilename: 'gemma-4-12B-it-qat-UD-Q4_K_XL.gguf', size: 6_716_000_000 }
    ])
    expect(file?.rfilename).toBe('gemma-4-12B-it-qat-UD-Q4_K_XL.gguf')
  })

  it('ignores anything filed away in a subfolder', () => {
    expect(isSingleFileGguf('MTP/mtp-gemma-4-12B-it-Q4_0.gguf')).toBe(false)
    expect(isSingleFileGguf('gemma-4-12B-it-qat-UD-Q4_K_XL.gguf')).toBe(true)
  })

  it('never selects an mmproj file as the chat model', () => {
    const file = pickBestGgufFile([
      { rfilename: 'mmproj-F16.gguf', size: 800_000_000 },
      { rfilename: 'model-q4_k_m.gguf', size: 4_000_000_000 }
    ])
    expect(file?.rfilename).toBe('model-q4_k_m.gguf')
  })
})

describe('pickVisionProjector', () => {
  it('prefers the F16 projector published alongside a vision model', () => {
    const projector = pickVisionProjector([
      { rfilename: 'model-q4_k_m.gguf', size: 4_000_000_000 },
      { rfilename: 'mmproj-Q8_0.gguf', size: 450_000_000 },
      { rfilename: 'mmproj-BF16.gguf', size: 780_000_000 },
      { rfilename: 'mmproj-F16.gguf', size: 800_000_000 }
    ])
    expect(projector?.rfilename).toBe('mmproj-F16.gguf')
  })

  it('returns null when the repository has no projector', () => {
    expect(
      pickVisionProjector([{ rfilename: 'model-q4_k_m.gguf', size: 4_000_000_000 }])
    ).toBeNull()
  })
})

describe('estimateRamRequirements', () => {
  /**
   * Real llama.cpp load reports, all at an 8192 context, taken off this
   * project's own machine. `total` is every buffer the report lists: weights,
   * KV cache, recurrent state, compute and output.
   */
  const MEASURED = [
    { name: 'Qwen3-4B Q4_K_M', fileGb: 2.33, totalGb: 3.85 },
    { name: 'Devstral-Small 23.6B Q4_K_M', fileGb: 13.35, totalGb: 14.9 },
    { name: 'Qwen3.8-27B Q4_K_M', fileGb: 15.33, totalGb: 16.1 }
  ]

  it.each(MEASURED)('leaves $name room to run and room for the OS', ({ fileGb, totalGb }) => {
    const { minRamGb } = estimateRamRequirements(fileGb * 1024 ** 3)
    // Above what the model actually takes...
    expect(minRamGb).toBeGreaterThan(totalGb)
    // ...with at least two gigabytes over for the operating system, since
    // this is compared against total RAM rather than free RAM.
    expect(minRamGb - totalGb).toBeGreaterThanOrEqual(2)
  })

  it.each(MEASURED)('does not price $name out of a machine that fits it', ({ fileGb, totalGb }) => {
    const { minRamGb } = estimateRamRequirements(fileGb * 1024 ** 3)
    // The old estimate was `size * 2.8 + 3`, which asked 49GB for a model
    // needing 16 and left a 32GB gaming PC with nothing but 3B models. Twice
    // the real requirement is the line: past it, ordinary machines start
    // being told they cannot run what they can.
    expect(minRamGb).toBeLessThan(totalGb * 2)
  })

  it('still lets a 4GB machine hold a 1B model', () => {
    // At a flat +5 of headroom the smallest model in the catalog needed 6GB
    // and the smallest machine was offered nothing at all, which is worse
    // than offering it the one thing it can just about hold.
    const { minRamGb } = estimateRamRequirements(0.8 * 1024 ** 3)
    expect(minRamGb).toBeLessThanOrEqual(4)
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

  /**
   * The name rules alone recognised exactly one family. Measured against the
   * live catalogue, only 2 of 21 current models came back tool-capable, so
   * "Best Agent" could only ever offer a Qwen Coder — and once the newer one
   * was taken by another slot, the card showed a 732-day-old model. Reading
   * the template took that pool to 18 of 21.
   */
  const withTools = `{%- if tools %}{{- tools | tojson }}{%- endif %}
{%- if message.tool_calls %}{{- message.tool_calls[0].function.name }}{%- endif %}`

  it('believes a chat template that carries tool calls, whatever the model is called', () => {
    expect(inferSupportsTools('unsloth/Qwen3.8-27B-GGUF', [], withTools)).toBe(true)
    expect(inferSupportsTools('google/gemma-4-12B-it-qat-q4_0-gguf', [], withTools)).toBe(true)
  })

  it('believes a template that cannot carry one, over a hopeful tag', () => {
    expect(
      inferSupportsTools('some-org/agentic-sounding-GGUF', ['function-calling'], 'plain')
    ).toBe(false)
  })

  /**
   * The name rules stay ahead of the template because they encode something
   * the template cannot say: that these lines were measured calling tools
   * badly in practice, however willing their template looks.
   */
  it('keeps the measured family judgements ahead of the template', () => {
    expect(inferSupportsTools('bartowski/DeepSeek-V4-Pro-GGUF', [], withTools)).toBe(false)
    expect(inferSupportsTools('mistralai/Mistral-Large-GGUF', [], withTools)).toBe(false)
  })

  it('falls back to the tag when the repository publishes no template', () => {
    expect(inferSupportsTools('some-org/some-model-GGUF', ['function-calling'], undefined)).toBe(
      true
    )
    expect(inferSupportsTools('some-org/some-model-GGUF', ['chat'], undefined)).toBe(false)
  })
})

describe('templateHandlesTools', () => {
  it('needs both halves: the tools going in and the calls coming out', () => {
    expect(templateHandlesTools('{%- if tools %}{{ message.tool_calls }}{%- endif %}')).toBe(true)
    // A template that only takes a tool list, or only mentions the word, is
    // not one that can render a call back.
    expect(templateHandlesTools('{%- if tools %}{{ tools }}{%- endif %}')).toBe(false)
    expect(templateHandlesTools('You are a helpful assistant with tools.')).toBe(false)
    expect(templateHandlesTools('')).toBe(false)
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
              {
                id: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
                downloads: 154325,
                likes: 311,
                tags: ['code']
              }
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
              { rfilename: 'qwen2.5-coder-7b-instruct-fp16.gguf', size: 15_000_000_000 },
              { rfilename: 'mmproj-F16.gguf', size: 800_000_000 }
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
    expect(model.visionProjectorUrl).toBe(
      'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/mmproj-F16.gguf'
    )
    expect(model.tags).toContain('vision')
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

describe('which repositories Anodex will recommend on its own', () => {
  it('will not put a novelty fine-tune in front of somebody', () => {
    // Ranking by uptake surfaced this as the best agent model for a real machine.
    expect(isRecommendableRepo('bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF')).toBe(false)
    expect(isRecommendableRepo('bartowski/SomeModel-abliterated-GGUF')).toBe(false)
  })

  it('keeps a lab’s own model, whoever quantized it', () => {
    expect(isRecommendableRepo('unsloth/Qwen3.8-27B-GGUF')).toBe(true)
    expect(isRecommendableRepo('bartowski/google_gemma-3-27b-it-GGUF')).toBe(true)
    expect(isRecommendableRepo('Qwen/Qwen3-Coder-Next-GGUF')).toBe(true)
  })

  it('drops a stranger’s fine-tune republished by a quantizer', () => {
    // All three arrived in one live fetch, ahead of models anyone has heard of.
    expect(isRecommendableRepo('bartowski/endless-frontier_BigBang-v1-GGUF')).toBe(false)
    expect(isRecommendableRepo('bartowski/XYZAILab_XYZ-Aquila-mini-GGUF')).toBe(false)
    expect(isRecommendableRepo('bartowski/Kwaipilot_KAT-Coder-V2.5-Dev-GGUF')).toBe(false)
  })
})

describe('how fast a model is being taken up', () => {
  const now = Date.parse('2026-09-16T00:00:00Z')
  const daysAgo = (days: number): string => new Date(now - days * 86_400_000).toISOString()

  it('does not let a long life stand in for popularity', () => {
    // Real figures from the day this was written: the older repo leads on total
    // downloads and is a generation behind.
    const established = { downloads: 12_817_609, createdAt: daysAgo(412) }
    const current = { downloads: 9_456_089, createdAt: daysAgo(34) }

    expect(uptakeRate(current, now)).toBeGreaterThan(uptakeRate(established, now))
  })

  it('ignores a repository nobody has downloaded yet, however new', () => {
    expect(uptakeRate({ downloads: 40, createdAt: daysAgo(1) }, now)).toBe(0)
  })

  it('treats a repository with no date as old rather than guessing', () => {
    const dateless = uptakeRate({ downloads: 1_000_000 }, now)
    const dated = uptakeRate({ downloads: 1_000_000, createdAt: daysAgo(30) }, now)

    expect(dateless).toBeLessThan(dated)
    expect(dateless).toBeGreaterThan(0)
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
              {
                id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct-GGUF',
                downloads: 200000,
                likes: 500,
                tags: []
              }
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
            siblings: [
              { rfilename: 'qwen3-coder-30b-a3b-instruct-q4_k_m.gguf', size: 18_000_000_000 }
            ]
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
