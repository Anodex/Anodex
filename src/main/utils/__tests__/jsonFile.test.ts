import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseJsonText, readJsonSync } from '../jsonFile'

/**
 * Reading JSON that came off a disk rather than off the wire.
 *
 * On 2026-09-17 the user's `settings.json` was rewritten by something that
 * adds a byte order mark — PowerShell's `Out-File` and `Set-Content` both do,
 * as does Notepad — and the next launch could not read a file that was
 * otherwise complete and perfectly valid JSON. Every API key, every linked
 * mail account and every preference went to `settings.json.corrupt` and the
 * app started from defaults, over a single invisible character.
 *
 * Twenty-three reads across twenty-two stores had the same shape, including
 * the credential store and every conversation.
 *
 * Written with escapes throughout: a literal mark in this file would be
 * invisible to whoever reads it next, and the lint rule against irregular
 * whitespace rejects it anyway.
 */
describe('parseJsonText', () => {
  it('reads a file written with a byte order mark', () => {
    // The whole reason this exists. A mark is legal in UTF-8, invisible in
    // every editor, and fatal to `JSON.parse`.
    expect(parseJsonText('﻿{"theme":"dark"}')).toEqual({ theme: 'dark' })
  })

  it('reads an ordinary file unchanged', () => {
    expect(parseJsonText('{"theme":"dark"}')).toEqual({ theme: 'dark' })
  })

  it('still refuses a file that is actually broken', () => {
    // Tolerant of the mark and nothing else. Every store above is built to
    // quarantine what it cannot read, and quietly repairing a damaged file is
    // how half a conversation becomes the whole of it.
    expect(() => parseJsonText('{"theme":')).toThrow()
    expect(() => parseJsonText('')).toThrow()
  })

  it('does not swallow a mark in the middle', () => {
    // Anywhere but the start it is a real corruption rather than an encoding
    // convention, and should fail like any other stray byte. Inside a string
    // it is just a character, and always was.
    expect(() => parseJsonText('{"a":1}﻿{"b":2}')).toThrow()
    expect(() => parseJsonText('{"a﻿":1}')).not.toThrow()
  })

  it('strips one mark, not a run of them', () => {
    // Two is a file that has been through the mangle twice. Accepting it
    // would be guessing at what the writer meant.
    expect(() => parseJsonText('﻿﻿{"a":1}')).toThrow()
  })
})

describe('readJsonSync', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'anodex-json-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads a real file with real mark bytes on the front', () => {
    // Written as the three bytes PowerShell writes, rather than as a
    // JavaScript string — the encoding is the thing under test, and a string
    // literal would prove only that the string literal works.
    const path = join(dir, 'settings.json')
    writeFileSync(
      path,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"ok":true}')])
    )

    expect(readJsonSync(path)).toEqual({ ok: true })
  })

  it('reads one without', () => {
    const path = join(dir, 'plain.json')
    writeFileSync(path, '{"ok":true}', 'utf-8')

    expect(readJsonSync(path)).toEqual({ ok: true })
  })
})
