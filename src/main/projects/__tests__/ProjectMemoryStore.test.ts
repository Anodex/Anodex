import { describe, expect, it } from 'vitest'
import {
  capAssistantSummary,
  cleanSummaryText,
  validateProjectMemoryFile
} from '../ProjectMemoryStore'

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

describe('validateProjectMemoryFile', () => {
  const validTouch = { path: 'src/index.ts', action: 'write', at: 1 }
  const validEvent = {
    conversationId: 'c1',
    messageId: 'm1',
    createdAt: 1,
    changedFiles: ['src/index.ts'],
    successfulTools: ['edit_file'],
    failedTools: [],
    verification: [{ command: 'npm test', status: 'passed' }],
    assistantSummary: 'Fixed it.'
  }

  it('returns filesTouched/recentEvents from a well-formed file', () => {
    const result = validateProjectMemoryFile({
      version: 1,
      filesTouched: [validTouch],
      recentEvents: [validEvent]
    })
    expect(result).toEqual({ filesTouched: [validTouch], recentEvents: [validEvent] })
  })

  it('returns empty arrays for a completely malformed file instead of throwing', () => {
    expect(validateProjectMemoryFile(null)).toEqual({ filesTouched: [], recentEvents: [] })
    expect(validateProjectMemoryFile('not an object')).toEqual({
      filesTouched: [],
      recentEvents: []
    })
    expect(validateProjectMemoryFile({})).toEqual({ filesTouched: [], recentEvents: [] })
  })

  it('drops a file touch with an invalid action, keeping valid touches', () => {
    const badTouch = { path: 'x.ts', action: 'not-a-real-action', at: 1 }
    const result = validateProjectMemoryFile({ filesTouched: [validTouch, badTouch] })
    expect(result.filesTouched).toEqual([validTouch])
  })

  it('drops a recall event missing required fields, keeping valid events', () => {
    const badEvent = { conversationId: 'c2' }
    const result = validateProjectMemoryFile({ recentEvents: [validEvent, badEvent] })
    expect(result.recentEvents).toEqual([validEvent])
  })

  it('drops a recall event with a malformed verification entry', () => {
    const badVerification = { ...validEvent, verification: [{ command: 'x', status: 'maybe' }] }
    const result = validateProjectMemoryFile({ recentEvents: [badVerification] })
    expect(result.recentEvents).toEqual([])
  })
})
