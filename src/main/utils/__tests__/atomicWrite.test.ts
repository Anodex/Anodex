import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeJsonAtomic, writeTextAtomic } from '../atomicWrite'

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
