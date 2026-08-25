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
const read = (path: string): ToolCall =>
  call('read', { name: 'read_file', title: `Read ${path}`, touchedPaths: [path] })
const ran = (command: string): ToolCall =>
  call('command', { name: 'run_command', title: `Run: ${command}` })

describe('summarizeWork', () => {
  it('says nothing when there is nothing settled to describe', () => {
    expect(summarizeWork([])).toBeNull()
    expect(summarizeWork([call('read', { status: 'running' })])).toBeNull()
  })

  /** It sits beside the model's own prose, so it should read like prose. */
  it('reads as a sentence, capitalised', () => {
    expect(summarizeWork([wrote('src/app/ui.py')])).toBe('Edited ui.py')
    expect(summarizeWork([call('plan')])).toBe('Updated the plan')
  })

  it('names its subject rather than counting, when there is one', () => {
    expect(summarizeWork([ran('npm test')])).toBe('Ran npm test')
    expect(summarizeWork([read('src/physics.py')])).toBe('Read physics.py')
    expect(summarizeWork([call('web', { title: 'Search "orbital mechanics"' })])).toBe(
      'Searched for orbital mechanics'
    )
  })

  /** Where a change landed, not just which file moved. */
  it('names the function a single edit landed in', () => {
    const before = ['import math', '', 'def update_focus(self):', '    self.x = 1'].join('\n')
    const after = ['import math', '', 'def update_focus(self):', '    self.x = 2'].join('\n')
    const edit = call('write', {
      name: 'edit_file',
      title: 'Edit camera.py',
      touchedPaths: ['src/camera.py'],
      diff: { path: 'src/camera.py', before, after }
    })
    expect(summarizeWork([edit])).toBe('Edited update_focus in camera.py')
  })

  it('falls back to the file when the diff names no single subject', () => {
    const edit = call('write', {
      name: 'write_file',
      title: 'Write camera.py',
      touchedPaths: ['src/camera.py'],
      diff: { path: 'src/camera.py', before: 'old', after: 'entirely new' }
    })
    expect(summarizeWork([edit])).toBe('Edited camera.py')
  })

  it('counts once there is more than one subject', () => {
    expect(summarizeWork([wrote('a.ts'), wrote('b.ts'), wrote('a.ts')])).toBe('Edited 2 files')
    expect(summarizeWork([ran('a'), ran('b')])).toBe('Ran 2 commands')
  })

  it('leads with changes, because what a turn altered matters most', () => {
    expect(summarizeWork([read('a.ts'), read('b.ts'), wrote('main.py'), ran('pytest')])).toBe(
      'Edited main.py, ran pytest and read 2 files'
    )
  })

  it('puts a word before the last item, not a comma', () => {
    expect(summarizeWork([ran('ls'), read('a.ts')])).toBe('Ran ls and read a.ts')
  })

  it('keeps a long command to a glance', () => {
    const summary = summarizeWork([ran('python -m pytest tests/ -k "integration and slow" -vv')])
    expect(summary!.length).toBeLessThan(60)
    expect(summary).toContain('…')
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
    expect(summarizeWork([call('plan'), wrote('a.ts')])).toBe('Edited a.ts')
  })

  it('describes a change with no recorded path without inventing one', () => {
    expect(summarizeWork([call('write', { name: 'delete_file' })])).toBe('1 change')
  })
})
