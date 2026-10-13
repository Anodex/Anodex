import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PhoneShareStore, SHARE_KEEP_MS, mimeTypeFor } from '../phoneShares'

let root: string
let store: PhoneShareStore
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anodex-shelf-'))
  store = new PhoneShareStore(join(root, 'shelf'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function file(name: string, content: string): string {
  const path = join(root, name)
  writeFileSync(path, content)
  return path
}

describe('the shelf of files waiting for the phone', () => {
  it('keeps a copy, so the file sent is the file that arrives', async () => {
    const path = file('report.pdf', 'version one')
    const share = await store.add(path)
    writeFileSync(path, 'edited after sending')

    const chunk = await store.chunk(share.id, 0)
    expect(Buffer.from(chunk!.base64, 'base64').toString()).toBe('version one')
    expect(chunk).toMatchObject({ filename: 'report.pdf', mimeType: 'application/pdf', done: true })
  })

  it('lists newest first, and forgets a file once the phone has it', async () => {
    const first = await store.add(file('a.txt', 'a'), 1_000)
    const second = await store.add(file('b.txt', 'b'), 2_000)
    expect(store.list(3_000).map((share) => share.id)).toEqual([second.id, first.id])

    store.remove(first.id, 3_000)
    expect(store.list(3_000).map((share) => share.id)).toEqual([second.id])
    expect(await store.chunk(first.id, 0, 3_000)).toBeNull()
  })

  it('lets a file go after a week, copy and all', async () => {
    const share = await store.add(file('old.txt', 'old'), 0)
    expect(store.list(SHARE_KEEP_MS + 1)).toEqual([])
    expect(readdirSync(join(root, 'shelf'))).not.toContain(share.id)
  })

  it('refuses a folder', async () => {
    await expect(store.add(root)).rejects.toThrow(/not a file/)
  })

  it('names a media type by extension', () => {
    expect(mimeTypeFor('Friday budget.xlsx')).toContain('spreadsheet')
    expect(mimeTypeFor('notes')).toBe('application/octet-stream')
  })
})
