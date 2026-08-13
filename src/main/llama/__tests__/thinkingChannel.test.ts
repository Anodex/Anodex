import { describe, expect, it } from 'vitest'
import { appendThinking, shouldPromoteThinkingToAnswer } from '../thinkingChannel'

describe('shouldPromoteThinkingToAnswer', () => {
  /**
   * The driving case from chat `c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef`: rounds
   * that called a tool and produced only deliberation had that deliberation
   * promoted into the reply, and each round's contribution was appended to the
   * same message — so a long tool loop concatenated all of them into thousands
   * of visible characters of "Let me…" narration.
   */
  it('keeps deliberation hidden on a round that called a tool', () => {
    expect(shouldPromoteThinkingToAnswer('Let me read the full animate function…', true)).toBe(
      false
    )
  })

  /**
   * The fallback this promotion exists for, which must keep working: some
   * reasoning models emit their whole answer inside think tags and nothing
   * outside them. Suppressing that would show the user an empty bubble.
   */
  it('promotes a thought-only answer on a round with no tool call', () => {
    expect(
      shouldPromoteThinkingToAnswer('The canvas is 0x0 because the parent is display:none.', false)
    ).toBe(true)
  })

  /**
   * Size is deliberately not a criterion — see the module comment. A long
   * answer emitted inside think tags is rare but real, and refusing it would
   * trade a messy reply for an empty one.
   */
  it('promotes a long segment when no tool call competes with it', () => {
    expect(shouldPromoteThinkingToAnswer('word '.repeat(5_000), false)).toBe(true)
  })

  it('never promotes an empty or whitespace segment', () => {
    expect(shouldPromoteThinkingToAnswer('', false)).toBe(false)
    expect(shouldPromoteThinkingToAnswer('   \n  ', false)).toBe(false)
  })
})

describe('appendThinking', () => {
  it('separates segments with a blank line', () => {
    expect(appendThinking('first', 'second')).toBe('first\n\nsecond')
  })

  it('starts from an empty accumulator without leading separators', () => {
    expect(appendThinking('', 'first')).toBe('first')
  })

  it('trims each segment as it is appended', () => {
    expect(appendThinking('first', '  second  ')).toBe('first\n\nsecond')
  })

  it('ignores a whitespace-only segment', () => {
    expect(appendThinking('first', '   ')).toBe('first')
  })
})
