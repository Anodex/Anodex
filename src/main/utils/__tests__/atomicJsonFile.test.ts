import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeJsonFileAtomic } from '../atomicJsonFile'

/**
 * A store that writes straight onto its own file can destroy itself.
 *
 * `AgentRunStore.persist` called `writeFileSync` directly on `runs.json`. A
 * crash, a full disk or a kill part-way through leaves that file truncated —
 * and `loadRuns` catches the parse failure, logs "starting fresh", and returns
 * an empty list. A partial write therefore loses **every** run on record,
 * silently.
 *
 * `CriticalThinkingStore` in the same codebase already does this properly, to a
 * temp file and then a rename. A rename within a directory is atomic, so a
 * reader sees either the old file or the new one and never half of either.
 *
 * Not hypothetical: a real `EPERM` on exactly this rename was seen in the
 * Critical Thinking store on 2026-08-28, twice in four minutes, from a
 * transient Windows lock.
 */
describe('writeJsonFileAtomic', () => {
  let dir: string
  let target: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'anodex-atomic-'))
    target = join(dir, 'runs.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes the data', async () => {
    writeJsonFileAtomic(target, [{ id: 'run-1' }])
    expect(JSON.parse(await readFile(target, 'utf-8'))).toEqual([{ id: 'run-1' }])
  })

  it('replaces existing content', async () => {
    writeJsonFileAtomic(target, [{ id: 'first' }])
    writeJsonFileAtomic(target, [{ id: 'second' }])
    expect(JSON.parse(await readFile(target, 'utf-8'))).toEqual([{ id: 'second' }])
  })

  it('leaves no temp file behind on success', async () => {
    // A temp file per process id would otherwise accumulate one per run.
    writeJsonFileAtomic(target, [{ id: 'run-1' }])
    expect((await readdir(dir)).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('leaves the previous file untouched when the write fails', async () => {
    await writeFile(target, JSON.stringify([{ id: 'precious' }]), 'utf-8')

    // A value `JSON.stringify` cannot serialise: the failure happens before
    // anything is written, which is the point — the live file is never opened.
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => writeJsonFileAtomic(target, circular)).toThrow()

    expect(JSON.parse(await readFile(target, 'utf-8'))).toEqual([{ id: 'precious' }])
  })

  it('does not strand a temp file when the write fails', async () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => writeJsonFileAtomic(target, circular)).toThrow()
    expect((await readdir(dir)).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('surfaces the failure rather than swallowing it', () => {
    // The caller decides what a lost write means. `AgentRunStore` logs it;
    // hiding it inside here would remove that choice.
    expect(() => writeJsonFileAtomic(join(dir, 'no-such-dir', 'x.json'), [])).toThrow()
  })
})
