import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { readJsonSync } from '../utils/jsonFile'

/**
 * What a text model's conversations share at the start: the system prompt and
 * the tool definitions that were documented with it, without their handlers.
 *
 * Kept so a freshly loaded text model can read it before anybody asks
 * anything — `LlamaService.warmUpTextPrompt`. Within a session, new chats
 * already reuse what the last one read (see `ensureSession`), but after a load
 * the model has read nothing, so the first message paid for the whole prefix:
 * about 3,000 tokens, half a minute or more on integrated graphics.
 *
 * The vision runtime's equivalent is `PromptPrefixStore`, which holds requests
 * in llama-server's OpenAI shape. This one holds what node-llama-cpp renders.
 */
export interface TextPromptPrefix {
  modelPath: string
  systemPrompt: string
  /** Tool name to its documented description and parameter schema. */
  functions?: Record<string, { description?: string; params?: unknown }>
}

/**
 * Models remembered at once. One prefix each, the most recent: the prompt a
 * person last chatted with is the one they will most likely open with, and
 * whatever it does not share with the next message is only a trim away.
 */
const MAX_MODELS = 4

interface PrefixFile {
  version: 1
  prefixes: TextPromptPrefix[]
}

function isPrefix(candidate: unknown): candidate is TextPromptPrefix {
  const value = candidate as TextPromptPrefix | null
  return typeof value?.modelPath === 'string' && typeof value.systemPrompt === 'string'
}

/** The last prompt prefix read with each model, most recently used model first. */
export class TextPromptPrefixStore {
  private lastWritten: string | null = null

  constructor(private readonly file: () => string) {}

  /** Remember `prefix` as this model's, writing only when something changed. */
  save(prefix: TextPromptPrefix): void {
    const kept = [prefix, ...this.read().filter((other) => other.modelPath !== prefix.modelPath)]
    const serialized = JSON.stringify({
      version: 1,
      prefixes: kept.slice(0, MAX_MODELS)
    } satisfies PrefixFile)
    if (serialized === this.lastWritten) return
    try {
      const path = this.file()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, serialized, 'utf8')
      this.lastWritten = serialized
    } catch {
      // A warm-up is a nicety. Failing to remember one costs one slow first message.
    }
  }

  /** The prefix last read with this model, or null. */
  load(modelPath: string): TextPromptPrefix | null {
    return this.read().find((prefix) => prefix.modelPath === modelPath) ?? null
  }

  /** Everything on record; `[]` for a missing or unreadable file. */
  private read(): TextPromptPrefix[] {
    try {
      const prefixes = (readJsonSync(this.file()) as PrefixFile | null)?.prefixes
      return Array.isArray(prefixes) ? prefixes.filter(isPrefix) : []
    } catch {
      return []
    }
  }
}
