import { describe, expect, it } from 'vitest'
import type { WorkspaceTreeNode } from '@shared/workspaceFiles.types'
import { filterFileTree } from '../fileTreeSearch'

function file(name: string, path = name): WorkspaceTreeNode {
  return { type: 'file', path, name, sizeBytes: 10, modifiedAt: 0, editedBy: 'user' }
}

function folder(name: string, children: WorkspaceTreeNode[], path = name): WorkspaceTreeNode {
  return { type: 'folder', path, name, children }
}

describe('filterFileTree', () => {
  const tree: WorkspaceTreeNode[] = [
    folder('src', [file('app.js', 'src/app.js'), file('utils.js', 'src/utils.js')]),
    folder('images', [
      folder('icons', [file('logo.png', 'images/icons/logo.png')], 'images/icons')
    ]),
    file('README.md')
  ]

  it('returns the original tree unchanged for an empty query', () => {
    expect(filterFileTree(tree, '')).toBe(tree)
    expect(filterFileTree(tree, '   ')).toBe(tree)
  })

  it('matches a top-level file by name, case-insensitively', () => {
    const result = filterFileTree(tree, 'readme')
    expect(result).toEqual([file('README.md')])
  })

  it('keeps a folder and narrows its children when a nested file matches', () => {
    const result = filterFileTree(tree, 'app.js')
    expect(result).toEqual([folder('src', [file('app.js', 'src/app.js')])])
  })

  it('matches a deeply nested file, keeping only the path down to it', () => {
    const result = filterFileTree(tree, 'logo')
    expect(result).toEqual([
      folder('images', [
        folder('icons', [file('logo.png', 'images/icons/logo.png')], 'images/icons')
      ])
    ])
  })

  it('keeps a folder that matches by name even with no matching children', () => {
    const result = filterFileTree(tree, 'src')
    expect(result).toEqual([folder('src', [])])
  })

  it('returns an empty array when nothing matches', () => {
    expect(filterFileTree(tree, 'nonexistent')).toEqual([])
  })
})
