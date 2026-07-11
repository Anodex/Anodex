import { describe, expect, it } from 'vitest'
import { capAssistantSummary, cleanSummaryText } from '../ProjectMemoryStore'

describe('cleanSummaryText', () => {
  it('strips fenced code blocks, keeping surrounding prose', () => {
    const text =
      'I fixed the bug.\n\n```json\n{"name": "run_command", "arguments": {}}\n```\n\nDone.'
    expect(cleanSummaryText(text)).toBe('I fixed the bug.\n\nDone.')
  })

  it('strips <tool_call> tags', () => {
    const text = 'Reading the file now.\n<tool_call>{"name": "read_file"}</tool_call>'
    expect(cleanSummaryText(text)).toBe('Reading the file now.')
  })

  it('returns an empty string when only a tool-call attempt remains', () => {
    const text = '```json\n{"name": "read_file", "arguments": {}}\n```'
    expect(cleanSummaryText(text)).toBe('')
  })

  it('leaves ordinary prose untouched', () => {
    const text = 'Fixed the add function to use + instead of -.'
    expect(cleanSummaryText(text)).toBe(text)
  })

  it('collapses excess blank lines left behind by stripped blocks', () => {
    const text = 'Step one.\n\n```\ncode\n```\n\n\n\nStep two.'
    expect(cleanSummaryText(text)).toBe('Step one.\n\nStep two.')
  })
})

describe('capAssistantSummary', () => {
  it('returns undefined for an empty string', () => {
    expect(capAssistantSummary('')).toBeUndefined()
  })

  it('leaves short text untouched', () => {
    expect(capAssistantSummary('Fixed the bug.')).toBe('Fixed the bug.')
  })

  it('truncates long text with an ellipsis', () => {
    const long = 'x'.repeat(300)
    const capped = capAssistantSummary(long)
    expect(capped?.length).toBe(221) // 220 chars + the ellipsis character
    expect(capped?.endsWith('…')).toBe(true)
  })
})
