import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PromptPrefixStore } from '../promptWarmup'

describe('PromptPrefixStore', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const storeIn = (): { store: PromptPrefixStore; file: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'anodex-prefix-'))
    dirs.push(dir)
    const file = join(dir, 'nested', 'prompt-prefix.json')
    return { store: new PromptPrefixStore(() => file), file }
  }

  const prefix = {
    modelPath: 'C:/models/qwen.gguf',
    system: { role: 'system' as const, content: 'You are Anodex.' },
    tools: [{ type: 'function' as const, function: { name: 'read_file', parameters: {} } }]
  }

  it('remembers the prefix for the model it was used with, and only that model', () => {
    const { store } = storeIn()
    store.save(prefix)

    expect(store.load('C:/models/qwen.gguf')).toEqual(prefix)
    expect(store.load('C:/models/other.gguf')).toBeNull()
  })

  it('does not rewrite the file for a prefix it already wrote', () => {
    const { store, file } = storeIn()
    store.save(prefix)
    const written = statSync(file).mtimeMs
    store.save({ ...prefix })

    expect(statSync(file).mtimeMs).toBe(written)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(prefix)
  })

  it('treats a missing or unreadable file as nothing to warm', () => {
    expect(new PromptPrefixStore(() => '/nowhere/prompt-prefix.json').load('x')).toBeNull()
    expect(
      new PromptPrefixStore(() => {
        throw new Error('no user data yet')
      }).load('x')
    ).toBeNull()
  })
})
