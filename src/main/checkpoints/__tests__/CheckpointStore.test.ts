import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkpointStore } from '../CheckpointStore'

let roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
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

  it('lists project checkpoint history newest first', () => {
    const root = workspace()
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValueOnce(100).mockReturnValueOnce(200)
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'one.txt',
      before: 'before',
      after: 'after'
    })
    checkpointStore.recordChange(root, 'c2', 'm2', {
      path: 'two.txt',
      before: null,
      after: 'created'
    })
    now.mockRestore()

    const history = checkpointStore.list(root)

    expect(history).toHaveLength(2)
    expect(history.map((entry) => entry.messageId)).toEqual(['m2', 'm1'])
    expect(history[0].changedFiles).toEqual(['two.txt'])
    expect(typeof history[0].createdAt).toBe('number')
  })

  it('undoes a restore by reapplying the checkpoint after-state', () => {
    const root = workspace()
    const file = join(root, 'app.ts')
    writeFileSync(file, 'after', 'utf-8')
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'app.ts',
      before: 'before',
      after: 'after'
    })
    checkpointStore.restore(root, 'c1', 'm1')

    const result = checkpointStore.undoRestore(root, 'c1', 'm1')

    expect(result).toMatchObject({ undoneFiles: ['app.ts'], conflicts: [] })
    expect(result.checkpoint.restoredFiles).toEqual([])
    expect(result.checkpoint.restoredAt).toBeUndefined()
    expect(readFileSync(file, 'utf-8')).toBe('after')
  })

  it('undoes restore states for files that were created or deleted by the turn', () => {
    const root = workspace()
    const created = join(root, 'created.txt')
    const deleted = join(root, 'deleted.txt')
    writeFileSync(created, 'created by turn', 'utf-8')
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'created.txt',
      before: null,
      after: 'created by turn'
    })
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'deleted.txt',
      before: 'deleted by turn',
      after: null
    })
    checkpointStore.restore(root, 'c1', 'm1')

    checkpointStore.undoRestore(root, 'c1', 'm1')

    expect(readFileSync(created, 'utf-8')).toBe('created by turn')
    expect(existsSync(deleted)).toBe(false)
  })

  it('blocks undo when a restored file changed again unless overwrite is explicit', () => {
    const root = workspace()
    const file = join(root, 'app.ts')
    writeFileSync(file, 'after', 'utf-8')
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'app.ts',
      before: 'before',
      after: 'after'
    })
    checkpointStore.restore(root, 'c1', 'm1')
    writeFileSync(file, 'new work after restore', 'utf-8')

    const blocked = checkpointStore.undoRestore(root, 'c1', 'm1')
    expect(blocked).toMatchObject({ undoneFiles: [], conflicts: ['app.ts'] })
    expect(readFileSync(file, 'utf-8')).toBe('new work after restore')

    const forced = checkpointStore.undoRestore(root, 'c1', 'm1', { force: true })
    expect(forced).toMatchObject({ undoneFiles: ['app.ts'], conflicts: [] })
    expect(readFileSync(file, 'utf-8')).toBe('after')
  })

  it('restores and reapplies binary contents byte-for-byte without exposing base64 in previews', () => {
    const root = workspace()
    const file = join(root, 'image.bin')
    const before = Buffer.from([0, 1, 2, 3, 255, 128])
    const after = Buffer.from([0, 9, 8, 7, 6, 5, 4])
    writeFileSync(file, after)
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'image.bin',
      before: before.toString('base64'),
      after: after.toString('base64'),
      beforeEncoding: 'base64',
      afterEncoding: 'base64'
    })

    const preview = checkpointStore.inspect(root, 'c1', 'm1').files[0]
    expect(preview).toMatchObject({
      path: 'image.bin',
      binary: true,
      before: null,
      after: null,
      beforeSize: before.length,
      afterSize: after.length,
      conflicted: false
    })

    checkpointStore.restore(root, 'c1', 'm1')
    expect(readFileSync(file)).toEqual(before)

    checkpointStore.undoRestore(root, 'c1', 'm1')
    expect(readFileSync(file)).toEqual(after)
  })

  it('rolls overlapping discarded turns back in reverse transcript order', () => {
    const root = workspace()
    const file = join(root, 'app.ts')
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'app.ts',
      before: 'original',
      after: 'first edit'
    })
    checkpointStore.recordChange(root, 'c1', 'm2', {
      path: 'app.ts',
      before: 'first edit',
      after: 'second edit'
    })
    writeFileSync(file, 'second edit', 'utf-8')

    const result = checkpointStore.rollback(root, 'c1', ['m1', 'm2'])

    expect(result).toEqual({
      rolledBackMessages: ['m2', 'm1'],
      restoredFiles: ['app.ts'],
      skippedFiles: [],
      conflicts: []
    })
    expect(readFileSync(file, 'utf-8')).toBe('original')
    expect(checkpointStore.getSummary(root, 'c1', 'm1')?.restoredAt).toEqual(expect.any(Number))
    expect(checkpointStore.getSummary(root, 'c1', 'm2')?.restoredAt).toEqual(expect.any(Number))
  })

  it('does not partially roll back discarded turns when a file has newer work', () => {
    const root = workspace()
    writeFileSync(join(root, 'safe.txt'), 'after safe', 'utf-8')
    writeFileSync(join(root, 'conflict.txt'), 'newer user work', 'utf-8')
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'safe.txt',
      before: 'before safe',
      after: 'after safe'
    })
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'conflict.txt',
      before: 'before conflict',
      after: 'after conflict'
    })

    const result = checkpointStore.rollback(root, 'c1', ['m1'])

    expect(result).toMatchObject({
      rolledBackMessages: [],
      restoredFiles: [],
      conflicts: ['conflict.txt']
    })
    expect(readFileSync(join(root, 'safe.txt'), 'utf-8')).toBe('after safe')
    expect(readFileSync(join(root, 'conflict.txt'), 'utf-8')).toBe('newer user work')
  })

  it('can keep conflicting files while rolling back every safe discarded change', () => {
    const root = workspace()
    writeFileSync(join(root, 'safe.txt'), 'after safe', 'utf-8')
    writeFileSync(join(root, 'conflict.txt'), 'newer user work', 'utf-8')
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'safe.txt',
      before: 'before safe',
      after: 'after safe'
    })
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'conflict.txt',
      before: 'before conflict',
      after: 'after conflict'
    })

    const result = checkpointStore.rollback(root, 'c1', ['m1'], {
      excludePaths: ['conflict.txt']
    })

    expect(result).toEqual({
      rolledBackMessages: ['m1'],
      restoredFiles: ['safe.txt'],
      skippedFiles: ['conflict.txt'],
      conflicts: []
    })
    expect(readFileSync(join(root, 'safe.txt'), 'utf-8')).toBe('before safe')
    expect(readFileSync(join(root, 'conflict.txt'), 'utf-8')).toBe('newer user work')
    expect(checkpointStore.getSummary(root, 'c1', 'm1')).toMatchObject({
      restoredFiles: ['safe.txt'],
      restoredAt: undefined
    })
  })

  it('can explicitly overwrite newer work while rolling discarded turns back', () => {
    const root = workspace()
    const file = join(root, 'app.ts')
    writeFileSync(file, 'newer user work', 'utf-8')
    checkpointStore.recordChange(root, 'c1', 'm1', {
      path: 'app.ts',
      before: 'original',
      after: 'assistant edit'
    })

    const result = checkpointStore.rollback(root, 'c1', ['m1'], { force: true })

    expect(result.conflicts).toEqual([])
    expect(result.restoredFiles).toEqual(['app.ts'])
    expect(readFileSync(file, 'utf-8')).toBe('original')
  })
})
