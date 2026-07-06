import { describe, expect, it } from 'vitest'
import { buildSideBySideDiffRows, buildUnifiedDiffLines, diffStats } from '../diffRows'

describe('buildUnifiedDiffLines', () => {
  it('marks unchanged, removed, and added lines in order', () => {
    const lines = buildUnifiedDiffLines('a\nb\nc\n', 'a\nx\nc\n')
    expect(lines).toEqual([
      { type: 'unchanged', text: 'a' },
      { type: 'removed', text: 'b' },
      { type: 'added', text: 'x' },
      { type: 'unchanged', text: 'c' }
    ])
  })

  it('handles a pure addition with no removals', () => {
    const lines = buildUnifiedDiffLines('a\n', 'a\nb\n')
    expect(lines).toEqual([
      { type: 'unchanged', text: 'a' },
      { type: 'added', text: 'b' }
    ])
  })
})

describe('buildSideBySideDiffRows', () => {
  it('aligns a same-length replacement row by row', () => {
    const rows = buildSideBySideDiffRows('a\nb\nc\n', 'a\nx\nc\n')
    expect(rows).toEqual([
      { left: { type: 'unchanged', text: 'a' }, right: { type: 'unchanged', text: 'a' } },
      { left: { type: 'removed', text: 'b' }, right: { type: 'added', text: 'x' } },
      { left: { type: 'unchanged', text: 'c' }, right: { type: 'unchanged', text: 'c' } }
    ])
  })

  it('pads the shorter side with blank rows when a replacement changes line count', () => {
    const rows = buildSideBySideDiffRows('one\ntwo\n', 'one\ntwo\nthree\n')
    expect(rows).toEqual([
      { left: { type: 'unchanged', text: 'one' }, right: { type: 'unchanged', text: 'one' } },
      { left: { type: 'unchanged', text: 'two' }, right: { type: 'unchanged', text: 'two' } },
      { left: { type: 'blank', text: '' }, right: { type: 'added', text: 'three' } }
    ])
  })

  it('shows an unpaired removal with a blank on the right', () => {
    const rows = buildSideBySideDiffRows('keep\ngone\n', 'keep\n')
    expect(rows).toEqual([
      { left: { type: 'unchanged', text: 'keep' }, right: { type: 'unchanged', text: 'keep' } },
      { left: { type: 'removed', text: 'gone' }, right: { type: 'blank', text: '' } }
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
