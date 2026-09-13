import { describe, expect, it } from 'vitest'
import { firstPlainLine, plainSummary, plainTitleLine } from '../titleText'

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

describe('plainSummary', () => {
  it('reads a run summary as text, without the outcome heading', () => {
    // As the agent card and the finished-run notification showed it.
    const summary =
      'Done looking.\n\n---\n**What this reply did**\n\n- **Changed** nothing — this reply only looked.'
    expect(plainSummary(summary)).toBe('Done looking. Changed nothing — this reply only looked.')
  })

  it('separates the lines of the account so they do not run together', () => {
    // As a phone notification showed it: "...only looked. Looked at 1 search Plan all
    // 2 steps complete".
    const summary = [
      '---',
      '**What this reply did**',
      '',
      '- **Changed** nothing — this reply only looked.',
      '- **Looked at** 1 search',
      '- **Plan** all 2 steps complete'
    ].join('\n')
    expect(plainSummary(summary)).toBe(
      'Changed nothing — this reply only looked. Looked at 1 search. Plan all 2 steps complete'
    )
  })

  it('leaves an ordinary error message alone', () => {
    expect(plainSummary('Run stopped: the model provider failed.')).toBe(
      'Run stopped: the model provider failed.'
    )
  })
})
