import { describe, expect, it } from 'vitest'
import { buildPromptWithAttachments, type ComposerAttachment } from '../attachments'

function attachment(overrides: Partial<ComposerAttachment> = {}): ComposerAttachment {
  return {
    path: 'src/app.js',
    name: 'app.js',
    content: 'console.log("hi")',
    sizeBytes: 18,
    truncated: false,
    ...overrides
  }
}

describe('buildPromptWithAttachments', () => {
  it('returns the text unchanged when there are no attachments', () => {
    expect(buildPromptWithAttachments('hello', [])).toBe('hello')
  })

  it('prepends a single attachment block ahead of the typed text', () => {
    const result = buildPromptWithAttachments('what does this do?', [attachment()])

    expect(result).toBe(
      '--- Attached file: src/app.js ---\nconsole.log("hi")\n\nwhat does this do?'
    )
  })

  it('joins multiple attachments with a blank line between them', () => {
    const result = buildPromptWithAttachments('compare these', [
      attachment({ path: 'a.js', content: 'A' }),
      attachment({ path: 'b.js', content: 'B' })
    ])

    expect(result).toBe(
      '--- Attached file: a.js ---\nA\n\n--- Attached file: b.js ---\nB\n\ncompare these'
    )
  })

  it('notes truncation with the real original size', () => {
    const result = buildPromptWithAttachments('review it', [
      attachment({ content: 'x'.repeat(100), sizeBytes: 5000, truncated: true })
    ])

    expect(result).toContain('(truncated, showing first 100 of 5000 bytes)')
  })

  it('omits the trailing blank-line-plus-text when there is no typed text', () => {
    const result = buildPromptWithAttachments('', [attachment()])

    expect(result).toBe('--- Attached file: src/app.js ---\nconsole.log("hi")')
  })
})
