import { describe, expect, it } from 'vitest'
import { joinAfterTool } from '../roundText'
describe('joinAfterTool', () => {
  it('breaks the paragraph where a tool ran between two pieces of text', () => {
    expect(
      joinAfterTool(
        'I will ask for it in a box before saving it.',
        'That request was declined.',
        true
      )
    ).toBe('I will ask for it in a box before saving it.\n\nThat request was declined.')
  })

  it('streams on unchanged when no tool came between', () => {
    expect(joinAfterTool('Hello', ' there', false)).toBe('Hello there')
  })

  it('waits for real words, so a lone space after the tool does not take the break', () => {
    const afterSpace = joinAfterTool('Saving it.', ' ', true)
    expect(joinAfterTool(afterSpace, 'Done.', true)).toBe('Saving it.\n\nDone.')
  })

  it('adds nothing in front of a reply that starts after a tool', () => {
    expect(joinAfterTool('', 'Found it.', true)).toBe('Found it.')
  })
})
