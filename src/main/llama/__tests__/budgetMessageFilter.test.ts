import { describe, expect, it } from 'vitest'
import { createBudgetMessageFilter, withoutBudgetMessage } from '../budgetMessageFilter'
import { REASONING_BUDGET_MESSAGE } from '../reasoningOverrun'

function streamed(pieces: string[]): string {
  const filter = createBudgetMessageFilter()
  return pieces.map((piece) => filter.push(piece)).join('') + filter.flush()
}

describe('the reasoning-budget note in reply text', () => {
  it('is removed whole, with the space after it', () => {
    expect(withoutBudgetMessage(`Checking.\n\n${REASONING_BUDGET_MESSAGE}\n\nDone.`)).toBe(
      'Checking.\n\nDone.'
    )
  })

  it('is removed when it arrives one character at a time', () => {
    const text = `Before ${REASONING_BUDGET_MESSAGE} after`
    expect(streamed([...text])).toBe('Before after')
  })

  it("is removed in the note's earlier wording", () => {
    const older =
      "I have used my thinking budget. I'll stop planning now and make the next tool call with what I have already worked out."
    expect(withoutBudgetMessage(`A. ${older} B.`)).toBe('A. B.')
  })

  it('is removed every time it appears, even glued to a word', () => {
    expect(
      withoutBudgetMessage(`label is${REASONING_BUDGET_MESSAGE}x ${REASONING_BUDGET_MESSAGE}y`)
    ).toBe('label isx y')
  })

  it('leaves text that only starts like the note', () => {
    const own = 'I have used my thinking budget. Here is a long answer that goes on. '.repeat(6)
    expect(streamed([own])).toBe(own)
  })

  it('shows ordinary text without waiting for the stream to end', () => {
    const filter = createBudgetMessageFilter()
    expect(filter.push('Hello there, world')).toBe('Hello there, world')
    // Only a possible start of the note is held back, and only until it is ruled out.
    expect(filter.push('. I')).toBe('. ')
    expect(filter.push(' think so')).toBe('I think so')
    expect(filter.flush()).toBe('')
  })

  it('releases a held start when the stream ends', () => {
    const filter = createBudgetMessageFilter()
    expect(filter.push('The answer. I have')).toBe('The answer. ')
    expect(filter.flush()).toBe('I have')
  })
})
