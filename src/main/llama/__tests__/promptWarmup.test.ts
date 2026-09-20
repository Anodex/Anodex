import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
    expect(store.load('C:/models/qwen.gguf')).toEqual(prefix)
  })

  /**
   * The chat surface and the coding surface are different prompts carrying
   * different tools. Keeping only the last one used meant the other started
   * cold every time, which is the whole reason this store holds more than one.
   */
  const chatPrefix = {
    modelPath: 'C:/models/qwen.gguf',
    system: { role: 'system' as const, content: 'You are Anodex, in conversation.' },
    tools: [{ type: 'function' as const, function: { name: 'web_search', parameters: {} } }]
  }

  it('remembers several surfaces, most recently used first', () => {
    const { store } = storeIn()
    store.save(prefix)
    store.save(chatPrefix)

    expect(store.loadRecent('C:/models/qwen.gguf', 2)).toEqual([chatPrefix, prefix])
    expect(store.load('C:/models/qwen.gguf')).toEqual(chatPrefix)
  })

  it('moves a prefix used again to the front instead of listing it twice', () => {
    const { store } = storeIn()
    store.save(prefix)
    store.save(chatPrefix)
    store.save(prefix)

    expect(store.loadRecent('C:/models/qwen.gguf', 5)).toEqual([prefix, chatPrefix])
  })

  it('forgets the oldest once it is holding more than a warm-up can use', () => {
    const { store } = storeIn()
    for (let i = 0; i < 6; i++) {
      store.save({ ...prefix, system: { role: 'system', content: `prompt ${i}` } })
    }
    const kept = store.loadRecent('C:/models/qwen.gguf', 99)

    expect(kept).toHaveLength(4)
    expect(kept[0].system).toEqual({ role: 'system', content: 'prompt 5' })
  })

  it('only offers prefixes belonging to the model being warmed', () => {
    const { store } = storeIn()
    store.save(prefix)
    store.save({ ...chatPrefix, modelPath: 'C:/models/other.gguf' })

    expect(store.loadRecent('C:/models/qwen.gguf', 2)).toEqual([prefix])
    expect(store.loadRecent('C:/models/other.gguf', 2)).toHaveLength(1)
  })

  it('still warms one prefix from a file written before this store held a list', () => {
    const { store, file } = storeIn()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(prefix), 'utf8')

    expect(store.load('C:/models/qwen.gguf')).toEqual(prefix)
    expect(store.loadRecent('C:/models/qwen.gguf', 3)).toEqual([prefix])
  })

  it('keeps an upgraded file readable to itself afterwards', () => {
    const { store, file } = storeIn()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(prefix), 'utf8')
    store.save(chatPrefix)

    expect((JSON.parse(readFileSync(file, 'utf8')) as { version: number }).version).toBe(2)
    expect(store.loadRecent('C:/models/qwen.gguf', 3)).toEqual([chatPrefix, prefix])
  })

  it('asked for nothing, returns nothing', () => {
    const { store } = storeIn()
    store.save(prefix)

    expect(store.loadRecent('C:/models/qwen.gguf', 0)).toEqual([])
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
