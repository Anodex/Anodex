import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@shared/tools.types'
import { changedFilesOf } from '../changedFiles'

function edit(
  path: string,
  before: string,
  after: string,
  extra: Partial<ToolCall> = {}
): ToolCall {
  return {
    id: Math.random().toString(36).slice(2),
    name: 'edit_file',
    title: `Edit ${path}`,
    kind: 'write',
    status: 'success',
    touchedPaths: [path],
    diff: { path, before, after },
    ...extra
  }
}

describe('changedFilesOf', () => {
  it('names each changed file once, measured from its first state to its last', () => {
    const files = changedFilesOf([
      edit('src/game.html', '', 'a\nb\n'),
      edit('src/game.html', 'a\nb\n', 'a\nb\nc\n'),
      edit('README.md', 'old\n', 'new\n')
    ])
    expect(files).toEqual([
      { path: 'src/game.html', name: 'game.html', added: 3, removed: 0 },
      { path: 'README.md', name: 'README.md', added: 1, removed: 1 }
    ])
  })

  it('skips failed and running writes, and reads', () => {
    expect(
      changedFilesOf([
        edit('a.ts', '', 'x', { status: 'error' }),
        edit('b.ts', '', 'x', { status: 'running' }),
        edit('c.ts', '', 'x', { kind: 'read' })
      ])
    ).toEqual([])
  })

  it('keeps a change with no diff, such as a delete, without counts', () => {
    const removed: ToolCall = {
      id: 'd',
      name: 'delete_file',
      title: 'Delete old.ts',
      kind: 'write',
      status: 'success',
      touchedPaths: ['old.ts']
    }
    expect(changedFilesOf([removed])).toEqual([{ path: 'old.ts', name: 'old.ts' }])
  })

  it('treats a Windows path as the same file as its forward-slashed form', () => {
    const files = changedFilesOf([
      edit('src\\app.ts', '', 'x\n', { touchedPaths: ['src\\app.ts'] }),
      edit('src/app.ts', 'x\n', 'y\n')
    ])
    expect(files).toEqual([{ path: 'src/app.ts', name: 'app.ts', added: 1, removed: 0 }])
  })
})
