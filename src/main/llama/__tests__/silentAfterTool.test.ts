import { describe, expect, it } from 'vitest'
import { lineFromToolResult } from '../silentAfterTool'

describe('lineFromToolResult', () => {
  it('takes the outcome line an action tool writes first', () => {
    expect(
      lineFromToolResult('Reminder set: "send the timesheet".\nWhen: Every Fri at 5:00 PM')
    ).toBe('Reminder set: "send the timesheet".')
  })

  it("skips Anodex's own notes to the model", () => {
    expect(
      lineFromToolResult(
        '\n[evidence E1 · set_reminder · 293 chars]\n(Answer the person from this, in plain words.)\nScheduled "News".'
      )
    ).toBe('Scheduled "News".')
  })

  it('keeps an error, which is the outcome too', () => {
    expect(lineFromToolResult('Error: No phone is paired.')).toBe('Error: No phone is paired.')
  })

  it('shortens a line too long to be a reply', () => {
    const line = lineFromToolResult('x'.repeat(1000))
    expect(line?.length).toBe(300)
    expect(line?.endsWith('…')).toBe(true)
  })

  it('has nothing to offer for an empty result', () => {
    expect(lineFromToolResult('')).toBeNull()
    expect(lineFromToolResult(null)).toBeNull()
    expect(lineFromToolResult('\n(Answer the person from this, in plain words.)\n')).toBeNull()
  })
})
