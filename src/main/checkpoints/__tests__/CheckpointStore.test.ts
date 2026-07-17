import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkpointStore } from '../CheckpointStore'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'anodex-checkpoints-'))
  roots.push(root)
  return root
}

describe('CheckpointStore', () => {
  it('restores a changed file to the original contents', () => {
    const root = workspace()
    const file = join(root, 'src', 'app.ts')
    mkdirSync(join(root, 'src'))
    writeFileSync(file, 'before', 'utf-8')

    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'src/app.ts',
      before: 'before',
      after: 'after'
    })
    writeFileSync(file, 'after', 'utf-8')

    const result = checkpointStore.restore(root, 'c1', 'm1')

    expect(result.restoredFiles).toEqual(['src/app.ts'])
    expect(readFileSync(file, 'utf-8')).toBe('before')
    expect(checkpointStore.getSummary(root, 'c1', 'm1')?.restoredAt).toEqual(expect.any(Number))
  })

  it('removes a file created by the checkpointed turn', () => {
    const root = workspace()
    const file = join(root, 'new.txt')
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'new.txt',
      before: null,
      after: 'created'
    })
    writeFileSync(file, 'created', 'utf-8')

    checkpointStore.restore(root, 'c1', 'm1')

    expect(existsSync(file)).toBe(false)
  })

  it('keeps the first before-state when the same file changes more than once', () => {
    const root = workspace()
    const file = join(root, 'app.ts')
    writeFileSync(file, 'third', 'utf-8')
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'app.ts',
      before: 'first',
      after: 'second'
    })
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'app.ts',
      before: 'second',
      after: 'third'
    })

    checkpointStore.restore(root, 'c1', 'm1')

    expect(readFileSync(file, 'utf-8')).toBe('first')
  })

  it('classifies changes and reports files edited after the checkpoint as conflicts', () => {
    const root = workspace()
    const modified = join(root, 'modified.txt')
    const created = join(root, 'created.txt')
    writeFileSync(modified, 'newer work', 'utf-8')
    writeFileSync(created, 'created', 'utf-8')
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'modified.txt',
      before: 'before',
      after: 'after'
    })
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'created.txt',
      before: null,
      after: 'created'
    })
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'deleted.txt',
      before: 'deleted contents',
      after: null
    })

    const preview = checkpointStore.inspect(root, 'c1', 'm1')

    expect(preview.files).toMatchObject([
      { path: 'modified.txt', kind: 'modified', conflicted: true, restored: false },
      { path: 'created.txt', kind: 'created', conflicted: false, restored: false },
      { path: 'deleted.txt', kind: 'deleted', conflicted: false, restored: false }
    ])
  })

  it('blocks a stale restore unless overwrite is explicit', () => {
    const root = workspace()
    const file = join(root, 'app.ts')
    writeFileSync(file, 'newer work', 'utf-8')
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'app.ts',
      before: 'before',
      after: 'after'
    })

    const blocked = checkpointStore.restore(root, 'c1', 'm1', { paths: ['app.ts'] })
    expect(blocked).toMatchObject({ restoredFiles: [], conflicts: ['app.ts'] })
    expect(readFileSync(file, 'utf-8')).toBe('newer work')

    const forced = checkpointStore.restore(root, 'c1', 'm1', {
      paths: ['app.ts'],
      force: true
    })
    expect(forced).toMatchObject({ restoredFiles: ['app.ts'], conflicts: [] })
    expect(readFileSync(file, 'utf-8')).toBe('before')
  })

  it('tracks selective restores without completing the whole checkpoint', () => {
    const root = workspace()
    writeFileSync(join(root, 'one.txt'), 'after one', 'utf-8')
    writeFileSync(join(root, 'two.txt'), 'after two', 'utf-8')
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'one.txt',
      before: 'before one',
      after: 'after one'
    })
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'two.txt',
      before: 'before two',
      after: 'after two'
    })

    const first = checkpointStore.restore(root, 'c1', 'm1', { paths: ['one.txt'] })
    expect(first.checkpoint).toMatchObject({ restoredFiles: ['one.txt'] })
    expect(first.checkpoint.restoredAt).toBeUndefined()
    expect(checkpointStore.inspect(root, 'c1', 'm1').files).toMatchObject([
      { path: 'one.txt', restored: true, conflicted: false },
      { path: 'two.txt', restored: false, conflicted: false }
    ])

    const second = checkpointStore.restore(root, 'c1', 'm1', { paths: ['two.txt'] })
    expect(second.checkpoint.restoredFiles).toEqual(['one.txt', 'two.txt'])
    expect(second.checkpoint.restoredAt).toEqual(expect.any(Number))
  })
})
