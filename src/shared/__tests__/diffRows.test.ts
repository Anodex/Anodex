import { describe, expect, it } from 'vitest'
import { buildSideBySideDiffRows, buildUnifiedDiffLines, diffStats } from '../diffRows'

describe('buildUnifiedDiffLines', () => {
  it('marks unchanged, removed, and added lines in order, with line numbers', () => {
    const lines = buildUnifiedDiffLines('a\nb\nc\n', 'a\nx\nc\n')
    expect(lines).toEqual([
      { type: 'unchanged', text: 'a', oldLine: 1, newLine: 1 },
      { type: 'removed', text: 'b', oldLine: 2, newLine: null },
      { type: 'added', text: 'x', oldLine: null, newLine: 2 },
      { type: 'unchanged', text: 'c', oldLine: 3, newLine: 3 }
    ])
  })

  it('handles a pure addition with no removals', () => {
    const lines = buildUnifiedDiffLines('a\n', 'a\nb\n')
    expect(lines).toEqual([
      { type: 'unchanged', text: 'a', oldLine: 1, newLine: 1 },
      { type: 'added', text: 'b', oldLine: null, newLine: 2 }
    ])
  })

  it('collapses long unchanged runs into a gap, keeping context around the change', () => {
    const before = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
    const after = before.replace('line6', 'CHANGED')
    const lines = buildUnifiedDiffLines(before, after)

    const gaps = lines.filter((line) => line.type === 'gap')
    // 12 lines, 1 changed pair (line6 -> CHANGED) each keeping 3 lines of context on
    // either side => lines 1-2 collapsed, 3-5 kept, change, 7-9 kept, 10-12 collapsed.
    expect(gaps).toHaveLength(2)
    expect(gaps[0].count).toBe(2)
    expect(gaps[1].count).toBe(3)
    expect(lines[0]).toEqual({ type: 'gap', text: '', oldLine: null, newLine: null, count: 2 })
  })
})

describe('buildSideBySideDiffRows', () => {
  it('aligns a same-length replacement row by row, with line numbers', () => {
    const rows = buildSideBySideDiffRows('a\nb\nc\n', 'a\nx\nc\n')
    expect(rows).toEqual([
      {
        left: { type: 'unchanged', text: 'a', line: 1 },
        right: { type: 'unchanged', text: 'a', line: 1 }
      },
      {
        left: { type: 'removed', text: 'b', line: 2 },
        right: { type: 'added', text: 'x', line: 2 }
      },
      {
        left: { type: 'unchanged', text: 'c', line: 3 },
        right: { type: 'unchanged', text: 'c', line: 3 }
      }
    ])
  })

  it('pads the shorter side with blank rows when a replacement changes line count', () => {
    const rows = buildSideBySideDiffRows('one\ntwo\n', 'one\ntwo\nthree\n')
    expect(rows).toEqual([
      {
        left: { type: 'unchanged', text: 'one', line: 1 },
        right: { type: 'unchanged', text: 'one', line: 1 }
      },
      {
        left: { type: 'unchanged', text: 'two', line: 2 },
        right: { type: 'unchanged', text: 'two', line: 2 }
      },
      {
        left: { type: 'blank', text: '', line: null },
        right: { type: 'added', text: 'three', line: 3 }
      }
    ])
  })

  it('shows an unpaired removal with a blank on the right', () => {
    const rows = buildSideBySideDiffRows('keep\ngone\n', 'keep\n')
    expect(rows).toEqual([
      {
        left: { type: 'unchanged', text: 'keep', line: 1 },
        right: { type: 'unchanged', text: 'keep', line: 1 }
      },
      {
        left: { type: 'removed', text: 'gone', line: 2 },
        right: { type: 'blank', text: '', line: null }
      }
    ])
  })
})

describe('diffStats', () => {
  it('counts added and removed lines', () => {
    expect(diffStats('a\nb\nc\n', 'a\nx\nc\n')).toEqual({ added: 1, removed: 1 })
  })

  it('reports zero/zero for identical content', () => {
    expect(diffStats('same\n', 'same\n')).toEqual({ added: 0, removed: 0 })
  })
})
