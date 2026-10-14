import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TextPromptPrefixStore } from '../textPromptPrefix'

let dir: string | null = null

function store(): { store: TextPromptPrefixStore; file: string } {
  dir = mkdtempSync(join(tmpdir(), 'anodex-text-prefix-'))
  const file = join(dir, 'nested', 'text-prompt-prefix.json')
  return { store: new TextPromptPrefixStore(() => file), file }
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('TextPromptPrefixStore', () => {
  it('keeps the last opening read with each model', () => {
    const { store: prefixes } = store()
    prefixes.save({ modelPath: '/m/llama.gguf', systemPrompt: 'first' })
    prefixes.save({ modelPath: '/m/gemma.gguf', systemPrompt: 'gemma' })
    prefixes.save({
      modelPath: '/m/llama.gguf',
      systemPrompt: 'second',
      functions: { find_available_tool: { description: 'Search tools.', params: {} } }
    })

    expect(prefixes.load('/m/llama.gguf')).toEqual({
      modelPath: '/m/llama.gguf',
      systemPrompt: 'second',
      functions: { find_available_tool: { description: 'Search tools.', params: {} } }
    })
    expect(prefixes.load('/m/gemma.gguf')?.systemPrompt).toBe('gemma')
    expect(prefixes.load('/m/other.gguf')).toBeNull()
  })

  it('forgets the least recently used model past four', () => {
    const { store: prefixes } = store()
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      prefixes.save({ modelPath: `/m/${name}.gguf`, systemPrompt: name })
    }
    expect(prefixes.load('/m/a.gguf')).toBeNull()
    expect(prefixes.load('/m/e.gguf')?.systemPrompt).toBe('e')
  })

  it('reads a missing or damaged file as nothing remembered', () => {
    const { store: prefixes, file } = store()
    expect(prefixes.load('/m/llama.gguf')).toBeNull()
    prefixes.save({ modelPath: '/m/llama.gguf', systemPrompt: 'kept' })
    writeFileSync(file, '{ not json', 'utf8')
    expect(prefixes.load('/m/llama.gguf')).toBeNull()
  })

  it('does not rewrite an unchanged record', () => {
    const { store: prefixes, file } = store()
    prefixes.save({ modelPath: '/m/llama.gguf', systemPrompt: 'same' })
    writeFileSync(file, readFileSync(file, 'utf8').replace('same', 'edited'), 'utf8')
    prefixes.save({ modelPath: '/m/llama.gguf', systemPrompt: 'same' })
    // The second save matched what this store last wrote, so the file is left alone.
    expect(prefixes.load('/m/llama.gguf')?.systemPrompt).toBe('edited')
  })
})
