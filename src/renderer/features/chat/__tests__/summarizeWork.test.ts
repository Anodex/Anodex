import { describe, expect, it } from 'vitest'
import type { ToolCall, ToolKind } from '@shared/tools.types'
import { summarizeWork } from '../summarizeWork'

function call(kind: ToolKind, overrides: Partial<ToolCall> & { name?: string } = {}): ToolCall {
  return {
    id: Math.random().toString(36).slice(2),
    name: overrides.name ?? kind,
    kind,
    title: overrides.title ?? kind,
    status: 'success',
    ...overrides
  }
}

const wrote = (path: string): ToolCall =>
  call('write', { name: 'edit_file', title: `Edit ${path}`, touchedPaths: [path] })

describe('summarizeWork', () => {
  it('says nothing when there is nothing settled to describe', () => {
    expect(summarizeWork([])).toBeNull()
    expect(summarizeWork([call('read', { status: 'running' })])).toBeNull()
  })

  it('names the file when exactly one was changed', () => {
    expect(summarizeWork([wrote('src/app/ui.py')])).toBe('edited ui.py')
  })

  it('counts files when several were changed', () => {
    expect(summarizeWork([wrote('a.ts'), wrote('b.ts'), wrote('a.ts')])).toBe('edited 2 files')
  })

  it('leads with changes, because what a turn altered matters most', () => {
    const summary = summarizeWork([call('read'), call('read'), wrote('main.py'), call('command')])
    expect(summary).toBe('edited main.py, 1 command and read 2 files')
  })

  it('reads as a sentence, with a word before the last item', () => {
    expect(summarizeWork([call('command'), call('read')])).toBe('1 command and read 1 file')
  })

  it('singular and plural both read correctly', () => {
    expect(summarizeWork([call('command')])).toContain('1 command')
    expect(summarizeWork([call('command'), call('command')])).toContain('2 commands')
    expect(summarizeWork([call('web')])).toContain('1 search')
    expect(summarizeWork([call('web'), call('web')])).toContain('2 searches')
  })

  /**
   * A failure hidden behind a collapsed header is the one thing the header
   * should have mentioned.
   */
  it('surfaces failures rather than hiding them behind the fold', () => {
    const summary = summarizeWork([wrote('a.ts'), call('command', { status: 'error' })])
    expect(summary).toContain('1 failed')
  })

  it('mentions plan bookkeeping only when it is all that happened', () => {
    expect(summarizeWork([call('plan')])).toBe('updated the plan')
    expect(summarizeWork([call('plan'), wrote('a.ts')])).toBe('edited a.ts')
  })

  it('describes a change with no recorded path without inventing one', () => {
    expect(summarizeWork([call('write', { name: 'delete_file' })])).toBe('1 change')
  })
})
