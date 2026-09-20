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

/**
 * How many distinct prefixes are remembered per store.
 *
 * ## Why more than one
 *
 * This used to keep exactly one prefix — whichever was sent last — and that
 * made the warm-up almost useless in practice, because Anodex does not have
 * one prefix. A plain chat and a project run are different system prompts
 * (`CHAT_PROMPT` against `CODING_AGENT_PROMPT`) carrying different tool sets,
 * and they share no common start beyond a few tokens. Measured on the
 * machine this was investigated on: after a project run, `prompt-prefix.json`
 * held the coding-agent prompt and seventeen workspace tools, so the first
 * "Hello" in a plain chat warmed nothing it would use and paid **6,817 ms**
 * to read its own 4,785-token prefix. The same request against a warm cache
 * cost **90 ms**.
 *
 * Keeping a few and warming the most recent ones means the surface the user
 * was last working in is ready whichever it was, and both are ready when the
 * runtime has a slot each. Small on purpose: every warmed prefix is a real
 * generation request at load time, and each one costs what it saves.
 */
const MAX_REMEMBERED = 4

/** File shape written by this store. Version 1 was a single bare `PromptPrefix`. */
interface PrefixFile {
  version: 2
  prefixes: PromptPrefix[]
}

/** Two prefixes are the same warm-up if they would render the same tokens. */
function signature(prefix: PromptPrefix): string {
  return JSON.stringify([prefix.modelPath, prefix.system, prefix.tools ?? null])
}

function isPrefix(candidate: unknown): candidate is PromptPrefix {
  const value = candidate as PromptPrefix | null
  return (
    typeof value?.modelPath === 'string' &&
    typeof value.system === 'object' &&
    value.system !== null &&
    (value.system as { role?: unknown }).role === 'system'
  )
}

/**
 * Where recently used prefixes are kept, most recent first, and a copy of what
 * was last written so an unchanged list is not rewritten.
 */
export class PromptPrefixStore {
  private lastWritten: string | null = null

  constructor(private readonly file: () => string) {}

  /**
   * Remember the prefix a request was sent with, as the most recent one.
   *
   * Re-saving a prefix already on record moves it to the front rather than
   * adding a duplicate — that is what makes "the surface you were last in"
   * mean something. Writes only when the resulting list changed.
   */
  save(prefix: PromptPrefix): void {
    const kept = [prefix, ...this.read().filter((other) => signature(other) !== signature(prefix))]
    const next: PrefixFile = { version: 2, prefixes: kept.slice(0, MAX_REMEMBERED) }
    const serialized = JSON.stringify(next)
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
    return this.loadRecent(modelPath, 1)[0] ?? null
  }

  /**
   * Up to `limit` distinct prefixes last used with this model, most recent
   * first. Fewer than `limit` — or none — is the normal answer on a fresh
   * install or after a model change, and the caller warms what it gets.
   */
  loadRecent(modelPath: string, limit: number): PromptPrefix[] {
    if (limit <= 0) return []
    return this.read()
      .filter((prefix) => prefix.modelPath === modelPath)
      .slice(0, limit)
  }

  /** Everything on record, most recent first; `[]` for a missing or unreadable file. */
  private read(): PromptPrefix[] {
    try {
      const parsed = readJsonSync(this.file())
      // Version 1 wrote a single bare prefix. Reading it keeps one warm-up
      // working across the upgrade instead of starting the list empty.
      if (isPrefix(parsed)) return [parsed]
      const prefixes = (parsed as PrefixFile | null)?.prefixes
      return Array.isArray(prefixes) ? prefixes.filter(isPrefix) : []
    } catch {
      return []
    }
  }
}
