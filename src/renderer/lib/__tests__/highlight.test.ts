import { describe, expect, it } from 'vitest'
import { highlightCode } from '../highlight'

describe('highlightCode', () => {
  it('highlights a known language and reports it back', () => {
    const result = highlightCode('const x: number = 1', 'typescript')
    expect(result.language).toBe('typescript')
    expect(result.html).toContain('hljs-keyword')
  })

  it('resolves common fence aliases to their registered language', () => {
    const result = highlightCode('const x = 1', 'ts')
    expect(result.language).toBe('typescript')
  })

  it('never leaves raw unescaped markup for an unrecognized language', () => {
    const result = highlightCode('<div>&"1 < 2"</div>', 'not-a-real-language')
    // Auto-detection may tokenize this as markup, but the raw tag must not
    // survive un-escaped — every `<` becomes part of an `&lt;` or a `<span>` token.
    expect(result.html).not.toMatch(/<div>/)
  })

  it('never returns raw, unescaped angle brackets for arbitrary input', () => {
    const result = highlightCode('<script>alert(1)</script>', 'typescript')
    expect(result.html).not.toMatch(/<script>/)
  })
})
