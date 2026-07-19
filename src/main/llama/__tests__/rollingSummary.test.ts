import { describe, expect, it, vi } from 'vitest'
import {
  FALLBACK_DIGEST_MAX_TOKENS,
  foldIntoRollingSummary,
  MIN_CHUNK_CHARS_TO_SUMMARIZE,
  ROLLING_SUMMARY_TOKEN_CEILING,
  sliceTextByTokenBudget,
  truncateToTokenBudget
} from '../rollingSummary'

/** Deterministic fake tokenizer: 1 "token" per character, matching the other compaction test suites. */
const countTokens = (text: string): number => text.length

interface FakeItem {
  id: string
  text: string
}

function item(id: string, length: number): FakeItem {
  return { id, text: id.padEnd(length, 'x') }
}

const renderTranscript = (items: readonly FakeItem[]): string =>
  items.map((entry) => entry.text).join('\n')
const itemTranscriptCost = (entry: FakeItem): number => entry.text.length

describe('truncateToTokenBudget', () => {
  it('returns the text unchanged when it already fits', () => {
    expect(truncateToTokenBudget('short', 100, countTokens)).toBe('short')
  })

  it('shrinks oversized text under the budget and marks the truncation', () => {
    const result = truncateToTokenBudget('y'.repeat(1_000), 100, countTokens)
    expect(countTokens(result)).toBeLessThanOrEqual(100)
    expect(result.endsWith('… (truncated)')).toBe(true)
  })

  it('returns an empty string for a non-positive budget', () => {
    expect(truncateToTokenBudget('anything', 0, countTokens)).toBe('')
  })
})

describe('sliceTextByTokenBudget', () => {
  it('returns one slice when the text fits', () => {
    expect(sliceTextByTokenBudget('abc', 10, countTokens)).toEqual(['abc'])
  })

  it('splits oversized text into consecutive slices under budget that reassemble losslessly', () => {
    const text = 'z'.repeat(950)
    const slices = sliceTextByTokenBudget(text, 300, countTokens)
    expect(slices.length).toBeGreaterThan(1)
    for (const slice of slices) expect(countTokens(slice)).toBeLessThanOrEqual(300)
    expect(slices.join('')).toBe(text)
  })
})

describe('foldIntoRollingSummary', () => {
  it('returns the previous summary unchanged when there is nothing to fold', async () => {
    const summarize = vi.fn()
    const result = await foldIntoRollingSummary<FakeItem>({
      items: [],
      previousSummary: 'existing facts',
      renderTranscript,
      itemTranscriptCost,
      countTokens,
      summarize
    })
    expect(result).toBe('existing facts')
    expect(summarize).not.toHaveBeenCalled()
  })

  it('folds chunk-by-chunk, passing the running summary to each call (replacement style)', async () => {
    const calls: Array<{ transcript: string; previous?: string }> = []
    const summarize = vi.fn((transcript: string, previous?: string) => {
      calls.push({ transcript, previous })
      return Promise.resolve(`S${calls.length}`)
    })

    const result = await foldIntoRollingSummary<FakeItem>({
      items: [item('a', 400), item('b', 400), item('c', 400)],
      previousSummary: 'S0',
      renderTranscript,
      itemTranscriptCost,
      countTokens,
      summarize,
      chunkTokenBudget: 500
    })

    // 400+400 exceeds 500 so each item folds as its own chunk.
    expect(calls).toHaveLength(3)
    expect(calls[0].previous).toBe('S0')
    expect(calls[1].previous).toBe('S1')
    expect(calls[2].previous).toBe('S2')
    // Replacement, not concatenation: the result is the last returned summary alone.
    expect(result).toBe('S3')
  })

  it('groups multiple small items into one chunk under the budget', async () => {
    const summarize = vi.fn((_transcript: string, _previous?: string) =>
      Promise.resolve('combined summary')
    )
    await foldIntoRollingSummary<FakeItem>({
      items: [item('a', 150), item('b', 150), item('c', 150)],
      previousSummary: undefined,
      renderTranscript,
      itemTranscriptCost,
      countTokens,
      summarize,
      chunkTokenBudget: 1_000
    })
    expect(summarize).toHaveBeenCalledOnce()
    expect(summarize.mock.calls[0][0]).toContain('a')
    expect(summarize.mock.calls[0][0]).toContain('c')
  })

  it('accounts for separators added by the fully rendered chunk', async () => {
    const received: string[] = []
    const summarize = vi.fn((transcript: string) => {
      received.push(transcript)
      return Promise.resolve('bounded combined summary')
    })
    await foldIntoRollingSummary<FakeItem>({
      items: [item('a', 120), item('b', 120)],
      previousSummary: undefined,
      renderTranscript,
      itemTranscriptCost,
      countTokens,
      summarize,
      chunkTokenBudget: 240
    })

    expect(received).toHaveLength(2)
    for (const transcript of received) expect(countTokens(transcript)).toBeLessThanOrEqual(240)
  })

  it('slices a single item whose transcript alone exceeds the chunk budget', async () => {
    const summarize = vi.fn((_transcript: string, _previous?: string) =>
      Promise.resolve('slice summary')
    )
    await foldIntoRollingSummary<FakeItem>({
      items: [item('mega', 2_000)],
      previousSummary: undefined,
      renderTranscript,
      itemTranscriptCost,
      countTokens,
      summarize,
      chunkTokenBudget: 600
    })
    expect(summarize.mock.calls.length).toBeGreaterThan(1)
    for (const call of summarize.mock.calls) {
      expect(countTokens(call[0])).toBeLessThanOrEqual(600)
    }
  })

  it('degrades one failed chunk to a hard-capped digest while keeping other chunks summarized', async () => {
    let callIndex = 0
    const summarize = vi.fn((_transcript: string, _previous?: string) => {
      callIndex += 1
      return Promise.resolve(callIndex === 1 ? null : 'llm summary')
    })

    const result = await foldIntoRollingSummary<FakeItem>({
      items: [item('failing', 700), item('working', 700)],
      previousSummary: undefined,
      renderTranscript,
      itemTranscriptCost,
      countTokens,
      summarize,
      chunkTokenBudget: 800
    })

    // Chunk 1 failed -> digest; chunk 2 succeeded and its replacement summary
    // (which received the digest as previous context) wins.
    expect(summarize).toHaveBeenCalledTimes(2)
    expect(summarize.mock.calls[1][1]).toContain('failing')
    expect(result).toBe('llm summary')
  })

  it('caps the digest of a failed chunk instead of copying it wholesale', async () => {
    const summarize = vi.fn((_transcript: string, _previous?: string) => Promise.resolve(null))
    const result = await foldIntoRollingSummary<FakeItem>({
      items: [item('bigfail', 3_000)],
      previousSummary: undefined,
      renderTranscript,
      itemTranscriptCost,
      countTokens,
      summarize,
      chunkTokenBudget: 5_000
    })
    expect(result).toBeDefined()
    expect(countTokens(result!)).toBeLessThanOrEqual(FALLBACK_DIGEST_MAX_TOKENS)
  })

  it('never grows past the rolling ceiling even when every chunk fails', async () => {
    const summarize = vi.fn((_transcript: string, _previous?: string) => Promise.resolve(null))
    const result = await foldIntoRollingSummary<FakeItem>({
      items: Array.from({ length: 12 }, (_, i) => item(`fail${i}`, 900)),
      previousSummary: undefined,
      renderTranscript,
      itemTranscriptCost,
      countTokens,
      summarize,
      chunkTokenBudget: 1_000
    })
    expect(result).toBeDefined()
    expect(countTokens(result!)).toBeLessThanOrEqual(ROLLING_SUMMARY_TOKEN_CEILING)
  })

  it('makes room for a failed new chunk when the previous summary is already at the ceiling', async () => {
    const previousSummary = 'p'.repeat(ROLLING_SUMMARY_TOKEN_CEILING)
    const result = await foldIntoRollingSummary<FakeItem>({
      items: [item('new-evidence', 300)],
      previousSummary,
      renderTranscript,
      itemTranscriptCost,
      countTokens,
      summarize: () => Promise.resolve(null)
    })

    expect(result).toContain('new-evidence')
    expect(result).not.toBe(previousSummary)
    expect(countTokens(result!)).toBeLessThanOrEqual(ROLLING_SUMMARY_TOKEN_CEILING)
  })

  it('treats a thrown summarizer error as a failed chunk, not a fold-wide failure', async () => {
    const summarize = vi
      .fn<(transcript: string, previous?: string) => Promise<string | null>>()
      .mockRejectedValueOnce(new Error('cloud SDK exploded'))
      .mockResolvedValueOnce('recovered summary')

    const result = await foldIntoRollingSummary<FakeItem>({
      items: [item('boom', 700), item('fine', 700)],
      previousSummary: undefined,
      renderTranscript,
      itemTranscriptCost,
      countTokens,
      summarize,
      chunkTokenBudget: 800
    })
    expect(result).toBe('recovered summary')
  })

  it('sends tiny chunks straight to the digest path without a summarizer round-trip', async () => {
    const summarize = vi.fn((_transcript: string, _previous?: string) =>
      Promise.resolve('should not be called')
    )
    const tiny = item('t', MIN_CHUNK_CHARS_TO_SUMMARIZE - 20)
    const result = await foldIntoRollingSummary<FakeItem>({
      items: [tiny],
      previousSummary: undefined,
      renderTranscript,
      itemTranscriptCost,
      countTokens,
      summarize
    })
    expect(summarize).not.toHaveBeenCalled()
    expect(result).toContain('t')
  })
})
