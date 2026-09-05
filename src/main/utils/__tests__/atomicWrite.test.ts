import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `rename` is destructured at import time and an ESM namespace cannot be
 * spied, so the seam has to be the module itself. `renameControl.impl` is null
 * for every test that does not care, and those calls go straight through to the
 * real implementation.
 */
/**
 * Attempts a failing rename makes before giving up: the first try plus one per
 * entry in the module's retry-delay table.
 */
const RENAME_ATTEMPTS = 5
const renameControl = vi.hoisted(() => ({
  impl: null as null | ((from: string, to: string) => Promise<void>),
  calls: 0,
  syncImpl: null as null | ((from: string, to: string) => void),
  syncCalls: 0
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      renameControl.syncCalls++
      if (renameControl.syncImpl) return renameControl.syncImpl(from, to)
      return actual.renameSync(from, to)
    }
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: (from: string, to: string) => {
      renameControl.calls++
      return renameControl.impl ? renameControl.impl(from, to) : actual.rename(from, to)
    }
  }
})

import {
  isTransientRenameError,
  writeJsonAtomic,
  writeJsonAtomicAsync,
  writeTextAtomic
} from '../atomicWrite'

describe('writeJsonAtomic', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anodex-atomic-write-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes valid, parseable JSON to the target path', async () => {
    const target = join(dir, 'data.json')
    writeJsonAtomic(target, { hello: 'world' })

    const raw = await readFile(target, 'utf-8')
    expect(JSON.parse(raw)).toEqual({ hello: 'world' })
  })

  it('overwrites an existing file cleanly', async () => {
    const target = join(dir, 'data.json')
    writeJsonAtomic(target, { version: 1 })
    writeJsonAtomic(target, { version: 2 })

    const raw = await readFile(target, 'utf-8')
    expect(JSON.parse(raw)).toEqual({ version: 2 })
  })

  it('leaves no leftover temp file behind after a successful write', () => {
    const target = join(dir, 'data.json')
    writeJsonAtomic(target, { ok: true })

    const files = readdirSync(dir)
    expect(files).toEqual(['data.json'])
  })
})

/**
 * A store that writes straight onto its own file can destroy itself. Several
 * did: `AgentRunStore`, `ConversationStore`, `SchedulerStore`, `ProjectStore`,
 * `SettingsStore` and others called `writeFileSync` on the live path, and every
 * one of their loaders treats a parse failure as "start fresh" and returns
 * nothing. A write interrupted by a crash or a full disk therefore deleted the
 * whole store, silently.
 *
 * Not hypothetical: a real EPERM on exactly this rename was seen in the
 * Critical Thinking store on 2026-08-28, twice in four minutes, from a
 * transient Windows lock.
 */
describe('atomic writes protect what is already on disk', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anodex-atomic-guard-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('leaves the previous file untouched when the write fails', async () => {
    const target = join(dir, 'store.json')
    writeJsonAtomic(target, { id: 'precious' })

    // A value `JSON.stringify` cannot serialise: this must fail before the
    // temp file exists, so the live file is never opened at all.
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => writeJsonAtomic(target, circular)).toThrow()

    expect(JSON.parse(await readFile(target, 'utf-8'))).toEqual({ id: 'precious' })
  })

  it('strands no temp file when the write fails', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => writeJsonAtomic(join(dir, 'store.json'), circular)).toThrow()
    expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('writes non-JSON text with the same guarantee', async () => {
    const target = join(dir, 'proposal.md')
    writeTextAtomic(target, '# Proposal')
    expect(await readFile(target, 'utf-8')).toBe('# Proposal')
    expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('surfaces the failure rather than swallowing it', () => {
    // What a lost write means is the caller's decision; hiding it here would
    // take that choice away.
    expect(() => writeJsonAtomic(join(dir, 'no-such-dir', 'x.json'), [])).toThrow()
  })
})

/**
 * Windows fails a rename onto a file any process has open, reporting `EPERM`
 * rather than the sharing conflict it is — antivirus, Windows Search, backup
 * agents and anything reading the store all hold a handle for a few
 * milliseconds. Two Critical Thinking runs died on exactly that:
 * `EPERM ... rename runs.json.<pid>.tmp`, once at step 5 of 7 after five
 * minutes of research, one failed rename discarding the whole run.
 */
describe('a transient rename conflict does not lose the write', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anodex-atomic-retry-'))
    renameControl.impl = null
    renameControl.calls = 0
    renameControl.syncImpl = null
    renameControl.syncCalls = 0
  })

  afterEach(async () => {
    renameControl.impl = null
    renameControl.syncImpl = null
    await rm(dir, { recursive: true, force: true })
  })

  const errnoWith = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: simulated`), { code })

  it('retries the synchronous path too, which every other store uses', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    // `writeTextAtomic`/`writeJsonAtomic` back conversations, checkpoints,
    // agent runs, the code index and the change library. The async form is
    // Critical Thinking's alone, so leaving the retry off this path would have
    // fixed the one store that had already been seen to fail and left every
    // other store losing writes to the same transient lock.
    let failures = 2
    renameControl.syncImpl = (from, to) => {
      if (failures-- > 0) throw errnoWith('EPERM')
      // Falling through to the mock would recurse; the second call has to
      // reach the real implementation.
      return actualFs.renameSync(from, to)
    }

    const target = join(dir, 'conversation.json')
    writeJsonAtomic(target, { turns: 2 })

    expect(renameControl.syncCalls).toBe(3)
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ turns: 2 })
  })

  it('bounds the synchronous wait, because it blocks the main process', () => {
    // The retry sleeps with `Atomics.wait`, which stalls the Electron main
    // thread. That is the cost of not losing the write, and it is only paid on
    // a lock that is already failing, but it has to stay bounded.
    //
    // Counted, not timed. This first asserted wall-clock elapsed under 500ms
    // and failed on macOS CI at 535ms -- the sleeps total 150ms and the rest
    // was a loaded shared runner doing four writes and four cleanups. That
    // assertion measured the machine, not the code, and would have gone on
    // failing at random. The attempt count is the property that actually
    // bounds the wait, and it is deterministic.
    renameControl.syncImpl = () => {
      throw errnoWith('EBUSY')
    }

    expect(() => writeJsonAtomic(join(dir, 'x.json'), { a: 1 })).toThrow()
    // One attempt plus one per retry delay: a fixed, finite number of tries.
    expect(renameControl.syncCalls).toBe(RENAME_ATTEMPTS)
  })

  it('classifies the sharing-conflict codes Windows reports, and nothing else', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      expect(isTransientRenameError(errnoWith(code))).toBe(true)
    }
    // A missing temp file or a full disk is durable: retrying only delays the
    // report of a real problem.
    for (const code of ['ENOENT', 'ENOSPC', 'EROFS']) {
      expect(isTransientRenameError(errnoWith(code))).toBe(false)
    }
    expect(isTransientRenameError(new Error('no code'))).toBe(false)
    expect(isTransientRenameError(null)).toBe(false)
  })

  it('retries past a lock that clears, and the data lands', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let failures = 2
    renameControl.impl = async (from, to) => {
      if (failures-- > 0) throw errnoWith('EPERM')
      return actual.rename(from, to)
    }

    const target = join(dir, 'runs.json')
    await writeJsonAtomicAsync(target, { runs: 1 })

    expect(renameControl.calls).toBe(3)
    expect(JSON.parse(await readFile(target, 'utf-8'))).toEqual({ runs: 1 })
  })

  it('gives up on a lock that does not clear, rather than hanging the writer', async () => {
    renameControl.impl = () => Promise.reject(errnoWith('EPERM'))

    const target = join(dir, 'runs.json')
    await expect(writeJsonAtomicAsync(target, { runs: 1 })).rejects.toMatchObject({ code: 'EPERM' })
    // Bounded by a fixed number of attempts, so a genuinely locked file fails
    // instead of stalling every later write behind it. Counted rather than
    // timed, for the reason given on the synchronous case below.
    expect(renameControl.calls).toBe(RENAME_ATTEMPTS)
    // And it leaves no temp file behind to look like a salvageable backup.
    expect(readdirSync(dir)).toEqual([])
  })

  it('does not retry a durable failure', async () => {
    renameControl.impl = () => Promise.reject(errnoWith('ENOSPC'))

    await expect(writeJsonAtomicAsync(join(dir, 'runs.json'), { runs: 1 })).rejects.toMatchObject({
      code: 'ENOSPC'
    })
    // Retrying a full disk only delays the report of a real problem.
    expect(renameControl.calls).toBe(1)
  })
})
