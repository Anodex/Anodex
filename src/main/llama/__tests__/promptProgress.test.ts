import { describe, expect, it } from 'vitest'
import { promptProgressOf } from '../promptProgress'

/** llama-server's `prompt_progress` stream field, as measured on the user's machine. */
describe('promptProgressOf', () => {
  it('reads a cold prompt as processed out of total', () => {
    expect(
      promptProgressOf({ prompt_progress: { total: 7_041, cache: 0, processed: 2_048 } })
    ).toEqual({ done: 2_048, total: 7_041 })
  })

  it('does not count cached tokens twice — processed already includes them', () => {
    // The opening chunk of a request with a cached start, exactly as llama-server
    // b10549 sent it: 2,434 tokens still to read.
    expect(
      promptProgressOf({ prompt_progress: { total: 9_460, cache: 7_026, processed: 7_026 } })
    ).toEqual({ done: 7_026, total: 9_460 })
    expect(
      promptProgressOf({ prompt_progress: { total: 9_460, cache: 7_026, processed: 8_944 } })
    ).toEqual({ done: 8_944, total: 9_460 })
  })

  it('never reports more than the total', () => {
    expect(promptProgressOf({ prompt_progress: { total: 100, cache: 0, processed: 150 } })).toEqual(
      { done: 100, total: 100 }
    )
  })

  it('ignores chunks without progress, or with nothing to read', () => {
    expect(promptProgressOf({ choices: [] })).toBeNull()
    expect(promptProgressOf({ prompt_progress: { total: 0 } })).toBeNull()
    expect(promptProgressOf(null)).toBeNull()
  })
})
