import { describe, expect, it } from 'vitest'
import { changedSymbol } from '../changedSymbol'

const diff = (before: string, after: string) => ({ path: 'f', before, after })

describe('changedSymbol', () => {
  it('names the Python function a change landed in', () => {
    const before = ['import math', '', 'def update_focus(self):', '    self.x = 1', ''].join('\n')
    const after = ['import math', '', 'def update_focus(self):', '    self.x = 2', ''].join('\n')
    expect(changedSymbol(diff(before, after))).toBe('update_focus')
  })

  it('names the enclosing class when the change is not inside a method', () => {
    const before = ['class Camera:', '    SPEED = 1', ''].join('\n')
    const after = ['class Camera:', '    SPEED = 2', ''].join('\n')
    expect(changedSymbol(diff(before, after))).toBe('Camera')
  })

  it('names a TypeScript function', () => {
    const before = [
      'const a = 1',
      '',
      'export function render(x: number) {',
      '  return x',
      '}'
    ].join('\n')
    const after = [
      'const a = 1',
      '',
      'export function render(x: number) {',
      '  return x + 1',
      '}'
    ].join('\n')
    expect(changedSymbol(diff(before, after))).toBe('render')
  })

  it('names an arrow constant', () => {
    const before = ['const build = () => {', '  return 1', '}'].join('\n')
    const after = ['const build = () => {', '  return 2', '}'].join('\n')
    expect(changedSymbol(diff(before, after))).toBe('build')
  })

  it('picks the nearest definition above the change, not the first in the file', () => {
    const before = ['def first():', '    pass', '', 'def second():', '    return 1'].join('\n')
    const after = ['def first():', '    pass', '', 'def second():', '    return 2'].join('\n')
    expect(changedSymbol(diff(before, after))).toBe('second')
  })

  it('finds a change made by appending to the end of a function', () => {
    const before = ['def grow():', '    a = 1'].join('\n')
    const after = ['def grow():', '    a = 1', '    b = 2'].join('\n')
    expect(changedSymbol(diff(before, after))).toBe('grow')
  })

  /**
   * A missing name costs a little detail. A wrong one is a small lie, so every
   * uncertain case answers null rather than guessing.
   */
  it('says nothing when there is no diff or nothing changed', () => {
    expect(changedSymbol(undefined)).toBeNull()
    expect(changedSymbol(diff('same\n', 'same\n'))).toBeNull()
  })

  it('says nothing for a rewrite that differs from its first line', () => {
    expect(changedSymbol(diff('def a():\n    pass', 'totally different\n'))).toBeNull()
  })

  it('says nothing when the change sits above any definition', () => {
    const before = ['import os', '', 'def later():', '    pass'].join('\n')
    const after = ['import os, sys', '', 'def later():', '    pass'].join('\n')
    expect(changedSymbol(diff(before, after))).toBeNull()
  })

  it('does not mistake a control-flow block for a definition', () => {
    const before = ['def outer():', '  if (ready) {', '    go(1)'].join('\n')
    const after = ['def outer():', '  if (ready) {', '    go(2)'].join('\n')
    expect(changedSymbol(diff(before, after))).toBe('outer')
  })
})
