import { describe, expect, it } from 'vitest'
import { firstPlainLine, plainTitleLine } from '../titleText'

describe('plainTitleLine', () => {
  it('drops emphasis and code marks but keeps the words', () => {
    // Seen as a sidebar title, cut to 44 characters with the marks still in it.
    expect(plainTitleLine('Yes. Here is the **single combined master prompt**, with `refs`')).toBe(
      'Yes. Here is the single combined master prompt, with refs'
    )
    expect(plainTitleLine('__Plan__ the *release*')).toBe('Plan the release')
  })

  it('drops a heading, quote or list prefix', () => {
    expect(plainTitleLine('## Plan the release')).toBe('Plan the release')
    expect(plainTitleLine('> Plan the release')).toBe('Plan the release')
    expect(plainTitleLine('- Plan the release')).toBe('Plan the release')
    expect(plainTitleLine('1. Plan the release')).toBe('Plan the release')
  })

  it('leaves asterisks that are not emphasis alone', () => {
    expect(plainTitleLine('2 * 3 * 4 is 24')).toBe('2 * 3 * 4 is 24')
    expect(plainTitleLine('glob src/**/*.ts')).toBe('glob src/**/*.ts')
    expect(plainTitleLine('Why does __init__.py run twice')).toBe('Why does __init__.py run twice')
  })

  it('treats a line of only marks as empty', () => {
    expect(plainTitleLine('****')).toBe('')
    expect(plainTitleLine('---')).toBe('')
  })
})

describe('firstPlainLine', () => {
  it('skips blank lines and lines of only marks', () => {
    expect(firstPlainLine('\n****\n  **Fix the jitter**\nmore')).toBe('Fix the jitter')
  })

  it('is empty when nothing is left', () => {
    expect(firstPlainLine('  \n---\n')).toBe('')
  })
})
