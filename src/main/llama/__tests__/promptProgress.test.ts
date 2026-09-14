import { describe, expect, it } from 'vitest'
import { promptProgressOf } from '../promptProgress'

/** llama-server's `prompt_progress` stream field, as measured on the user's machine. */
describe('promptProgressOf', () => {
  it('counts cached tokens as already read', () => {
    expect(
      promptProgressOf({ prompt_progress: { total: 9_840, cache: 6_000, processed: 2_048 } })
    ).toEqual({ done: 8_048, total: 9_840 })
  })

  it('never reports more than the total', () => {
    expect(promptProgressOf({ prompt_progress: { total: 100, cache: 90, processed: 50 } })).toEqual(
      { done: 100, total: 100 }
    )
  })

  it('ignores chunks without progress, or with nothing to read', () => {
    expect(promptProgressOf({ choices: [] })).toBeNull()
    expect(promptProgressOf({ prompt_progress: { total: 0 } })).toBeNull()
    expect(promptProgressOf(null)).toBeNull()
  })
})
