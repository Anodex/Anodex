/**
 * Notices a native tool call whose arguments the model has lost track of.
 *
 * Measured with Gemma 4 E4B on Windows, "How much free disk space do I have?"
 * ended this way 2 of 8 times, each one the full 15-minute time limit with
 * nothing on screen. The model wrote `{"check": "disk", "name": "C:\"`: in
 * JSON the backslash makes that quote part of the text, so the string never
 * closed. The model carried on as if it had: it wrote its end-of-call marker,
 * its thoughts, and then its whole answer, inventing drives D: to K:, all of it
 * inside one argument the grammar would not let it leave. 6,444 tokens and
 * 35,399 characters, and `check_computer` takes a few words. The backslash is
 * one way in; `"path": "/}}` is another, a string the model simply never
 * closed before ending the call the way its own format does.
 *
 * The sign in every case was the model's own turn markers (`<tool_call|>`,
 * `<|channel>`) appearing inside the arguments. A model writes those only to
 * structure its turn, never as the value of a field, so seeing one there means
 * the call has already gone wrong; waiting longer only spends the turn.
 *
 * "Its own" is decided by the model's vocabulary, not a list: a marker this
 * model reads as one token is one of its markers. Measured on both bundled
 * models, Gemma 4 reads `<tool_call|>` and `<|channel>` as one token and
 * Llama 3.1's `<|eot_id|>` as seven; Llama reads `<|eot_id|>` and
 * `<|python_tag|>` as one and Gemma's markers as four or five. ChatML's
 * `<|im_start|>`, as text in a file being written, is six tokens to both and is
 * left alone. Gemma 4 does not flag its markers as special tokens at all, which
 * is why the test is the token count.
 */
export class RunawayToolCallWatch {
  /** Each in-flight call's arguments so far. */
  private readonly calls = new Map<number, string>()

  /**
   * @param isModelToken whether `marker` is a single token of this model's
   * vocabulary: see `LlamaService`, which asks the model's tokenizer.
   */
  constructor(private readonly isModelToken: (marker: string) => boolean) {}

  /**
   * The call's arguments up to the first of the model's own turn markers, once
   * one appears in them, and null until then.
   */
  observe(callIndex: number, chunk: string): string | null {
    const before = this.calls.get(callIndex) ?? ''
    const text = before + chunk
    this.calls.set(callIndex, text)
    // Only the new chunk and enough before it to hold a marker split across two.
    const from = Math.max(0, before.length - MAX_MARKER_CHARS)
    MARKER_SHAPE.lastIndex = from
    for (let match = MARKER_SHAPE.exec(text); match; match = MARKER_SHAPE.exec(text)) {
      if (this.isModelToken(match[0])) return text.slice(0, match.index)
    }
    return null
  }
}

/**
 * The arguments the model meant, from what it wrote before losing track, when
 * that is unambiguous; null otherwise.
 *
 * In every case measured the intent was plain: `{"check": "disk", "path": "/}}`
 * is `{"check": "disk", "path": "/"}` with the closing quote missing, and
 * `"name": "C:\",` is `"name": "C:\\",` with the backslash meant as a
 * character. So: drop the closing braces the model wrote for its own format,
 * then try closing the open string and the object, with and without reading a
 * backslash before a quote as a character. The first reading that is a JSON
 * object, names only fields the tool has, includes every field it requires and
 * keeps every value it allows, is the call. Nothing is guessed beyond that.
 */
export function salvageArguments(written: string, schema: unknown): Record<string, unknown> | null {
  const body = written.trimEnd().replace(/\}+$/, '').trimEnd()
  const literalBackslashes = body.replace(/(?<!\\)\\"(?=\s*(?:,|$))/g, '\\\\"')
  for (const base of [body, literalBackslashes]) {
    for (const ending of ['}', '"}']) {
      const args = parseObject(base + ending)
      if (args && fitsSchema(args, schema)) return args
    }
  }
  return null
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

interface ObjectSchema {
  properties?: Record<string, { type?: string; enum?: readonly unknown[] }>
  required?: readonly string[]
}

/** The top level of a tool's parameter schema: the fields, the required ones, and their allowed values. */
function fitsSchema(args: Record<string, unknown>, schema: unknown): boolean {
  const { properties = {}, required = [] } = (schema ?? {}) as ObjectSchema
  if (required.some((name) => !(name in args))) return false
  return Object.entries(args).every(([name, value]) => {
    const field = properties[name]
    if (!field) return false
    if (field.enum && !field.enum.includes(value)) return false
    if (field.type === 'string') return typeof value === 'string'
    if (field.type === 'number' || field.type === 'integer') return typeof value === 'number'
    if (field.type === 'boolean') return typeof value === 'boolean'
    return true
  })
}

/** `<|word>`, `<word|>` and `<|word|>`: the shapes chat templates give their markers. */
const MARKER_SHAPE = /<\|[A-Za-z_]{1,32}\|?>|<[A-Za-z_]{1,32}\|>/g

/** The longest text `MARKER_SHAPE` matches. */
const MAX_MARKER_CHARS = 36
