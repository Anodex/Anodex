import { describe, expect, it, vi } from 'vitest'
import type { ModelDownloadProgress } from '@shared/model.types'

// `ActiveDownloads` pulls in `modelStore`, which reaches the preload bridge at
// module load. The summariser under test never touches it.
vi.mock('../../../lib/anodex', () => ({ anodex: { models: {} } }))

const { summariseActiveDownloads } = await import('../activeDownloadSummary')

const downloading = (
  modelId: string,
  receivedBytes: number,
  totalBytes: number | null
): ModelDownloadProgress => ({ modelId, receivedBytes, totalBytes, status: 'downloading' })

describe('summariseActiveDownloads', () => {
  it('says nothing at all when nothing is downloading', () => {
    expect(summariseActiveDownloads({}, {})).toBeNull()
  })

  /**
   * The reported bug. A model downloaded from a search lived only on the
   * Discover panel's `useState` results, so leaving Settings and coming back
   * unmounted the only card drawing its progress and the download looked
   * stopped. Nothing here comes from a card — the store alone is enough to
   * report, which is what lets the title bar survive the navigation.
   */
  it('reports a download that no card is rendering', () => {
    const summary = summariseActiveDownloads(
      { 'hf:searched': downloading('hf:searched', 3_000_000, 12_000_000) },
      { 'hf:searched': 'Qwen3.8 27B' }
    )

    expect(summary).toEqual({ label: 'Qwen3.8 27B', percent: 25, names: ['Qwen3.8 27B'] })
  })

  it('names the count rather than one of them when several are running', () => {
    const summary = summariseActiveDownloads(
      { a: downloading('a', 1, 10), b: downloading('b', 2, 10) },
      { a: 'First', b: 'Second' }
    )

    expect(summary?.label).toBe('2 models downloading')
    expect(summary?.names).toEqual(['First', 'Second'])
  })

  it('adds downloads by bytes, not by averaging their percentages', () => {
    // 3 of 10 and 7 of 30 is 10 of 40 — 25%. Averaging the two percentages
    // would say 27%, and would be further out the more the sizes differ.
    const summary = summariseActiveDownloads(
      { a: downloading('a', 3, 10), b: downloading('b', 7, 30) },
      {}
    )

    expect(summary?.percent).toBe(25)
  })

  it('does not invent a percentage when the server sent no size', () => {
    const summary = summariseActiveDownloads({ a: downloading('a', 5_000_000, null) }, { a: 'X' })

    expect(summary?.percent).toBeNull()
    expect(summary?.label).toBe('X')
  })

  it('ignores a sizeless download rather than letting it drag the figure down', () => {
    // The unsized one is counted on neither side: 4 of 8 is still half.
    const summary = summariseActiveDownloads(
      { a: downloading('a', 4, 8), b: downloading('b', 1_000, null) },
      {}
    )

    expect(summary?.percent).toBe(50)
  })

  it('ignores downloads that have already finished or failed', () => {
    const summary = summariseActiveDownloads(
      {
        done: { modelId: 'done', receivedBytes: 10, totalBytes: 10, status: 'done' },
        failed: { modelId: 'failed', receivedBytes: 1, totalBytes: 10, status: 'error' },
        gone: { modelId: 'gone', receivedBytes: 1, totalBytes: 10, status: 'canceled' }
      },
      {}
    )

    expect(summary).toBeNull()
  })

  it('falls back to a plain label rather than showing an id as a name', () => {
    const summary = summariseActiveDownloads(
      { 'hf:unsloth/Qwen3.8-27B-GGUF': downloading('hf:unsloth/Qwen3.8-27B-GGUF', 1, 4) },
      {}
    )

    expect(summary?.label).toBe('Downloading a model')
  })

  it('never reports more than finished, however the bytes arrive', () => {
    const summary = summariseActiveDownloads({ a: downloading('a', 120, 100) }, {})

    expect(summary?.percent).toBe(100)
  })
})
