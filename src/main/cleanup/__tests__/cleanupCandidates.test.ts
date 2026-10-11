import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findCleanupCandidates, type CleanupEnv } from '../cleanupCandidates'

const DAY = 24 * 60 * 60 * 1000
let root: string

function file(path: string, bytes: number, ageDays = 0): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes))
  const when = new Date(Date.now() - ageDays * DAY)
  utimesSync(path, when, when)
}

function env(): CleanupEnv {
  return {
    platform: 'linux',
    home: join(root, 'home'),
    tmp: join(root, 'tmp'),
    downloads: join(root, 'home', 'Downloads'),
    env: {},
    now: Date.now()
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anodex-cleanup-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('findCleanupCandidates', () => {
  it('finds package caches, old temp files and year-old downloads, biggest first', async () => {
    file(join(root, 'home', '.npm', '_cacache', 'a', 'blob'), 3000)
    file(join(root, 'home', '.cache', 'pip', 'wheel'), 1000)
    file(join(root, 'tmp', 'old.log'), 500, 10)
    file(join(root, 'tmp', 'fresh.log'), 9999, 1)
    file(join(root, 'home', 'Downloads', 'ancient.zip'), 700, 400)
    file(join(root, 'home', 'Downloads', 'recent.zip'), 9999, 30)

    const found = await findCleanupCandidates(env())

    expect(found.map((c) => [c.id, c.sizeBytes])).toEqual([
      ['npm-cache', 3000],
      ['pip-cache', 1000],
      ['old-downloads', 700],
      ['old-temp-files', 500]
    ])
    expect(found.find((c) => c.id === 'old-downloads')?.paths).toEqual([
      join(root, 'home', 'Downloads', 'ancient.zip')
    ])
  })

  it('offers nothing where there is nothing', async () => {
    expect(await findCleanupCandidates(env())).toEqual([])
  })

  it('never follows a link out of a cache when sizing it', async () => {
    file(join(root, 'elsewhere', 'precious.bin'), 50_000)
    file(join(root, 'home', '.npm', '_cacache', 'small'), 10)
    try {
      symlinkSync(join(root, 'elsewhere'), join(root, 'home', '.npm', '_cacache', 'link'))
    } catch {
      return // symlinks need privileges on some Windows runners
    }
    const [npm] = await findCleanupCandidates(env())
    expect(npm.sizeBytes).toBe(10)
  })
})
