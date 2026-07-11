import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeJsonAtomic } from '../atomicWrite'

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
