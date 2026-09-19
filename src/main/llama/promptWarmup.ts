import { readJsonSync } from '../utils/jsonFile'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions/completions'

/**
 * The part of a chat request that stays the same from one message to the next:
 * the system prompt and the tool definitions, for one model.
 *
 * Kept so a freshly loaded model can read it before anybody asks anything. A local
 * model only skips what it has already read, and after a load it has read nothing,
 * so the first message of the day paid for the whole prefix — about ten seconds on
 * a 27B model — before writing a word.
 */
export interface PromptPrefix {
  modelPath: string
  system: ChatCompletionMessageParam
  tools?: ChatCompletionTool[]
}

/** Where the last prefix is kept, and a copy of it so a repeat is not rewritten. */
export class PromptPrefixStore {
  private lastWritten: string | null = null

  constructor(private readonly file: () => string) {}

  /** Remember the prefix a request was sent with. Writes only when it changed. */
  save(prefix: PromptPrefix): void {
    const serialized = JSON.stringify(prefix)
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

  /** The prefix last used with this model, or null. */
  load(modelPath: string): PromptPrefix | null {
    try {
      const parsed = readJsonSync(this.file()) as PromptPrefix
      if (parsed?.modelPath !== modelPath || parsed.system?.role !== 'system') return null
      return parsed
    } catch {
      return null
    }
  }
}
