import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { searchPersonalFiles } from '../personalFiles'
import { zip } from './zipFixture'

let root: string
function put(relative: string, content: string | Buffer, ageDays = 0): string {
  const path = join(root, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  const when = new Date(Date.now() - ageDays * 86_400_000)
  utimesSync(path, when, when)
  return path
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anodex-personal-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('searchPersonalFiles', () => {
  it('finds a file by name, newest first, and by folder name too', async () => {
    const recent = put('Documents/Budget 2026.xlsx', 'x', 1)
    const older = put('Documents/old/budget-2024.xlsx', 'x', 300)
    const inFolder = put('Desktop/Budget/notes.txt', 'agenda', 2)
    const found = await searchPersonalFiles({
      roots: [join(root, 'Documents'), join(root, 'Desktop')],
      words: ['budget']
    })
    expect(found.map((f) => f.path)).toEqual([recent, inFolder, older])
    expect(found[0].matched).toBe('name')
  })

  it('looks inside documents when the name does not say it', async () => {
    const doc = put(
      'Documents/meeting-notes.docx',
      zip({ 'word/document.xml': '<w:t>Budget for the Friday meeting: 42,000</w:t>' })
    )
    put('Documents/other.docx', zip({ 'word/document.xml': '<w:t>Holiday plans</w:t>' }))
    const found = await searchPersonalFiles({
      roots: [join(root, 'Documents')],
      words: ['budget', 'friday']
    })
    expect(found.map((f) => f.path)).toEqual([doc])
    expect(found[0].matched).toContain('Budget for the Friday meeting')
  })

  it('never searches hidden folders, where keys and settings live', async () => {
    put('Documents/.ssh/budget_key', 'secret')
    put('Documents/node_modules/budget/index.js', 'x')
    expect(
      await searchPersonalFiles({ roots: [join(root, 'Documents')], words: ['budget'] })
    ).toEqual([])
  })

  it('can keep to recent files', async () => {
    put('Documents/budget-old.txt', 'x', 90)
    const fresh = put('Documents/budget-new.txt', 'x', 3)
    const found = await searchPersonalFiles({
      roots: [join(root, 'Documents')],
      words: ['budget'],
      withinDays: 30
    })
    expect(found.map((f) => f.path)).toEqual([fresh])
  })
})
