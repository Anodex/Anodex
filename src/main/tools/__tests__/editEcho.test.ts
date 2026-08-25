import { describe, expect, it } from 'vitest'
import { describeEditResult } from '../editEcho'

const lines = (n: number, prefix = 'line'): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n')

const echo = (original: string, updated: string, charBudget = 3_000) =>
  describeEditResult({
    relativePath: 'src/ui.py',
    original,
    updated,
    charBudget,
    action: '1 replacement'
  })

describe('describeEditResult', () => {
  /**
   * The whole point: after an edit the model can see the result and its new
   * line numbers without spending a round trip re-reading the file.
   */
  it('quotes the edited region back with its post-edit line numbers', () => {
    const original = lines(20)
    const updated = original
      .split('\n')
      .map((l) => (l === 'line 10' ? 'CHANGED' : l))
      .join('\n')
    const result = echo(original, updated)
    expect(result.modelResult).toContain('[src/ui.py: lines 6-14 of 20 after the edit.')
    expect(result.modelResult).toContain('CHANGED')
    expect(result.modelResult).toContain('line 6')
    expect(result.modelResult).toContain('line 14')
    // Context only — lines well outside the window stay out of it.
    expect(result.modelResult).not.toContain('line 20')
  })

  it('says how far the line numbers moved when the count changed', () => {
    const original = lines(10)
    const updated = [
      ...original.split('\n').slice(0, 5),
      'extra a',
      'extra b',
      ...original.split('\n').slice(5)
    ].join('\n')
    const result = echo(original, updated)
    expect(result.modelResult).toContain('gained 2 lines')
    expect(result.modelResult).toContain('have shifted')
    expect(result.detail).toBe('1 replacement, now 12 lines')
  })

  it('reports a deletion without claiming a changed line that no longer exists', () => {
    const original = lines(10)
    const updated = original
      .split('\n')
      .filter((l) => l !== 'line 5')
      .join('\n')
    const result = echo(original, updated)
    expect(result.modelResult).toContain('lost 1 line,')
    expect(result.modelResult).toContain('of 9 after the edit')
  })

  it('reports the shape of a change too large to quote back', () => {
    const result = echo(lines(400), lines(400, 'other'))
    expect(result.modelResult).toContain('too much to quote back')
    expect(result.modelResult).toContain('The file now has 400 lines')
    expect(result.modelResult).not.toContain('other 200')
  })

  /**
   * A window trimmed to fit would no longer match the line numbers in its own
   * header, which is worse than not quoting it at all.
   */
  it('drops the quote rather than truncating it out of step with its header', () => {
    const original = lines(20)
    const updated = original
      .split('\n')
      .map((l) => (l === 'line 10' ? 'CHANGED' : l))
      .join('\n')
    const result = echo(original, updated, 60)
    expect(result.modelResult).toContain('not enough room left')
    expect(result.modelResult).not.toContain('CHANGED')
    expect(result.modelResult.length).toBeLessThanOrEqual(200)
  })

  it('says so plainly when a replacement changed nothing', () => {
    const same = lines(5)
    const result = echo(same, same)
    expect(result.modelResult).toContain('The file is unchanged.')
  })

  it('names the file and what was done in every form', () => {
    for (const result of [
      echo(lines(20), lines(20).replace('line 3', 'x')),
      echo(lines(400), lines(400, 'other')),
      echo(lines(5), lines(5))
    ]) {
      expect(result.modelResult.startsWith('Edited src/ui.py (1 replacement).')).toBe(true)
    }
  })
})
