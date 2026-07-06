import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectMemory } from '@shared/projectMemory.types'
import type { WorkspaceTreeNode } from '@shared/workspaceFiles.types'
import { determineEditedBy, listWorkspaceFiles } from '../listWorkspaceFiles'

function memoryWith(touches: ProjectMemory['filesTouched']): ProjectMemory {
  return { projectId: 'p1', filesTouched: touches, recentSummaries: [] }
}

describe('determineEditedBy', () => {
  it('attributes to the user when there is no touch record', () => {
    expect(determineEditedBy('a.js', Date.now(), null)).toBe('user')
    expect(determineEditedBy('a.js', Date.now(), memoryWith([]))).toBe('user')
  })

  it('attributes to the user when the only touch was a read', () => {
    const memory = memoryWith([{ path: 'a.js', action: 'read', at: Date.now() }])
    expect(determineEditedBy('a.js', Date.now(), memory)).toBe('user')
  })

  it('attributes to the AI when a write touch matches the file mtime', () => {
    const now = Date.now()
    const memory = memoryWith([{ path: 'a.js', action: 'write', at: now }])
    expect(determineEditedBy('a.js', now, memory)).toBe('ai')
  })

  it('attributes to the AI when a move touch matches the file mtime', () => {
    const now = Date.now()
    const memory = memoryWith([{ path: 'a.js', action: 'move', at: now }])
    expect(determineEditedBy('a.js', now, memory)).toBe('ai')
  })

  it('attributes to the user when the file was modified well after the AI write', () => {
    const writeAt = Date.now() - 10 * 60 * 1000
    const modifiedAt = Date.now()
    const memory = memoryWith([{ path: 'a.js', action: 'write', at: writeAt }])
    expect(determineEditedBy('a.js', modifiedAt, memory)).toBe('user')
  })

  it('tolerates small clock differences between the write and the mtime', () => {
    const writeAt = Date.now()
    const modifiedAt = writeAt + 1000
    const memory = memoryWith([{ path: 'a.js', action: 'write', at: writeAt }])
    expect(determineEditedBy('a.js', modifiedAt, memory)).toBe('ai')
  })
})

describe('listWorkspaceFiles', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-listfiles-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('lists root files with relative paths, sorted alphabetically', async () => {
    await writeFile(join(workspace, 'index.js'), 'x')
    await writeFile(join(workspace, 'node_modules-not-really.js'), 'x')

    const files = await listWorkspaceFiles(workspace, null)

    expect(files.map((f) => f.path)).toEqual(['index.js', 'node_modules-not-really.js'])
    expect(files.every((f) => f.type === 'file' && f.editedBy === 'user')).toBe(true)
  })

  it('returns an empty list for a workspace with no files', async () => {
    expect(await listWorkspaceFiles(workspace, null)).toEqual([])
  })

  it('nests files inside a real folder node, sorted before root-level files', async () => {
    await mkdir(join(workspace, 'src'))
    await writeFile(join(workspace, 'src', 'index.ts'), 'x')
    await writeFile(join(workspace, 'readme.md'), 'x')

    const nodes = await listWorkspaceFiles(workspace, null)

    expect(nodes).toHaveLength(2)
    expect(nodes[0]).toMatchObject({ type: 'folder', name: 'src', path: 'src' })
    expect(nodes[1]).toMatchObject({ type: 'file', name: 'readme.md' })
    const folder = nodes[0] as Extract<WorkspaceTreeNode, { type: 'folder' }>
    expect(folder.children).toHaveLength(1)
    expect(folder.children[0]).toMatchObject({
      type: 'file',
      name: 'index.ts',
      path: 'src/index.ts'
    })
  })

  it('handles multiple levels of nesting', async () => {
    await mkdir(join(workspace, 'a', 'b'), { recursive: true })
    await writeFile(join(workspace, 'a', 'b', 'deep.txt'), 'x')

    const nodes = await listWorkspaceFiles(workspace, null)

    const a = nodes[0] as Extract<WorkspaceTreeNode, { type: 'folder' }>
    expect(a).toMatchObject({ type: 'folder', name: 'a' })
    const b = a.children[0] as Extract<WorkspaceTreeNode, { type: 'folder' }>
    expect(b).toMatchObject({ type: 'folder', name: 'b', path: 'a/b' })
    expect(b.children).toEqual([
      expect.objectContaining({ type: 'file', name: 'deep.txt', path: 'a/b/deep.txt' })
    ])
  })

  it('omits a folder that ends up with no visible children', async () => {
    await mkdir(join(workspace, 'empty'))
    await writeFile(join(workspace, 'kept.txt'), 'x')

    const nodes = await listWorkspaceFiles(workspace, null)

    expect(nodes).toEqual([expect.objectContaining({ type: 'file', name: 'kept.txt' })])
  })

  it('skips noise directories entirely, including their contents', async () => {
    await mkdir(join(workspace, 'node_modules'))
    await writeFile(join(workspace, 'node_modules', 'pkg.js'), 'x')
    await writeFile(join(workspace, 'index.js'), 'x')

    const nodes = await listWorkspaceFiles(workspace, null)

    expect(nodes).toEqual([expect.objectContaining({ type: 'file', name: 'index.js' })])
  })
})
