/**
 * Recovery layer for local models that don't reliably trigger node-llama-cpp's
 * native function-calling grammar.
 *
 * `QwenChatWrapper` (and similar wrappers) instruct the model to wrap a call in
 * `<tool_call>{"name": ..., "arguments": ...}</tool_call>`, but small/quantized
 * instruct models frequently fail to emit the exact special tokens the wrapper
 * looks for — the call comes through as ordinary, unexecuted text instead (seen
 * directly with local Qwen2.5-Coder 3B/7B/14B GGUFs). This module detects that
 * exact failure shape after the fact, so the tool can still be run for real
 * instead of the model's "call" being silently dropped as inert text.
 *
 * Modeled on the parsing approach used by NousResearch's Hermes-Function-Calling
 * (which defined the `<tool_call>` convention Qwen adopted): accept a few known
 * wrapping shapes, parse strictly, and only accept a match whose `name` is an
 * actually-registered tool — never guess.
 *
 * Strictly a *parser*, and deliberately nothing more. This module used to also
 * carry a set of intent detectors — "does this reply claim a change that never
 * happened", "is it stalling", "did it fabricate an approval" — which the
 * caller used to re-prompt the model. Those are gone: recovering a malformed
 * call is reading syntax the model emitted, while judging whether a reply
 * *means* it made a change is guessing at intent from wording, and Anodex does
 * not let a phrase match drive orchestration. What a turn actually did is
 * recorded in its settled tool calls.
 */

import { DEEPSEEK_CALL_BEGIN, DEEPSEEK_SEP } from '@shared/deepSeekMarkers'

export interface FallbackToolCall {
  name: string
  arguments: Record<string, unknown>
  /** The exact substring of the response (including any tags/fences) to remove before display. */
  matchedText: string
}

const TOOL_CALL_TAG = /<tool_call>([\s\S]*?)<\/tool_call>/gi
const JSON_FENCE = /```(?:json)?\s*\n?([\s\S]*?)```/gi

/**
 * Self-closing XML-style pseudo-tag a model can write instead of calling a
 * tool — e.g. `<preview_html path="index.html" title="..." />`. Observed
 * directly with gemma4-coding-Q8_0: nudged to "call preview_html", it wrote a
 * plausible-looking tag literally in its reply text instead of using the
 * real function-calling mechanism, so the tool never ran and the tag leaked
 * into the chat transcript as visible text. Requires at least one attribute
 * so it can't match incidental markup like `<br/>`; the registered-tool-name
 * check in `detectFallbackToolCall` (same as every other candidate shape
 * here) keeps it from misfiring on unrelated HTML the model quotes.
 */
const SELF_CLOSING_TAG = /<([a-zA-Z][\w-]*)((?:\s+[\w-]+=(?:"[^"]*"|'[^']*'))+)\s*\/>/g
const TAG_ATTRIBUTE = /([\w-]+)=(?:"([^"]*)"|'([^']*)')/g

/**
 * Qwen-style pseudo-XML: `<function=search_files><parameter=path>js</parameter>…`,
 * usually but not always wrapped in `<tool_call>`. The body is not JSON, so
 * `TOOL_CALL_TAG` captured it and then failed to parse it — the call silently
 * never ran, the round produced no tool call, and the provider loop treated
 * that as the model being finished. Observed ending a live turn mid-fix, with
 * the raw tags left visible in the transcript.
 *
 * Matched by hand rather than one regex because the closing `</function>` and
 * `</tool_call>` are frequently absent (the model stops emitting once it
 * believes the call is made), so the block has to be allowed to run to the
 * next function tag or to the end of the text.
 */
const FUNCTION_TAG = /<function=([\w-]+)>/gi
const PARAMETER_BLOCK = /<parameter=([\w-]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/gi
/**
 * DeepSeek's own call syntax, leaked as text: the tool name follows
 * `<｜tool▁sep｜>` and the arguments sit in a separate fenced JSON block, so
 * neither half is a `{"name": …, "arguments": …}` object and every other shape
 * here misses it — `JSON_FENCE` captured the arguments and then rejected them
 * for having no `name`.
 *
 * A backstop rather than the primary path: the wrapper now declares DeepSeek's
 * call sections properly (see `deepSeekWrapper.ts`), so these calls are read
 * back natively. Before it did, only the first call of a section matched the
 * configured prefix and one live turn leaked eight — inventing an `edit_file`
 * success, a `run_command` transcript, and a web server on port 8000 while
 * changing nothing on disk. Keeping the parser costs nothing and the failure it
 * covers is silent, expensive, and produces confident fiction.
 */
const DEEPSEEK_CALL = new RegExp(
  // `String.raw` so the backslashes reach `RegExp` intact — in a plain template
  // literal `\s` is just `s`. `\x60` is a backtick, spelled that way so the
  // fence needs no escaping inside the raw literal.
  String.raw`${DEEPSEEK_CALL_BEGIN}\s*(?:function)?\s*${DEEPSEEK_SEP}\s*([\w-]+)\s*\n?\x60{3}(?:json)?\s*\n?([\s\S]*?)\x60{3}`,
  'g'
)

const TRAILING_WRAPPER = /^(?:\s*<\/function>)?(?:\s*<\/tool_call>)?/
const LEADING_WRAPPER = /<tool_call>\s*$/

/**
 * Look for a tool-call attempt in a model's plain-text response that wasn't
 * executed by native function-calling. Returns the first match whose `name`
 * is in `availableToolNames`, or `null` if nothing recognizable is found.
 */
export function detectFallbackToolCall(
  text: string,
  availableToolNames: ReadonlySet<string>
): FallbackToolCall | null {
  for (const { matchedText, jsonText } of extractCandidates(text)) {
    const parsed = tryParseToolCallJson(jsonText)
    if (parsed && availableToolNames.has(parsed.name)) {
      return { ...parsed, matchedText }
    }
  }
  return null
}

interface Candidate {
  /** The full original substring (with any tags/fences) — used to strip it from the displayed text. */
  matchedText: string
  /** The inner text expected to be a JSON tool-call object. */
  jsonText: string
}

function extractCandidates(text: string): Candidate[] {
  const candidates: Candidate[] = []

  candidates.push(...extractDeepSeekCandidates(text))
  for (const match of text.matchAll(TOOL_CALL_TAG)) {
    candidates.push({ matchedText: match[0], jsonText: match[1] })
  }
  for (const match of text.matchAll(JSON_FENCE)) {
    candidates.push({ matchedText: match[0], jsonText: match[1] })
  }
  candidates.push(...extractFunctionTagCandidates(text))
  for (const match of text.matchAll(SELF_CLOSING_TAG)) {
    const [matchedText, name, attrText] = match
    const args: Record<string, string> = {}
    for (const attr of attrText.matchAll(TAG_ATTRIBUTE)) {
      args[attr[1]] = attr[2] ?? attr[3] ?? ''
    }
    candidates.push({ matchedText, jsonText: JSON.stringify({ name, arguments: args }) })
  }

  // A bare JSON object with no wrapping tag/fence is accepted either as the
  // model's *entire* response, or sitting alone on its own line within a longer
  // explanation (e.g. "I'll list the directory.\n{"name": "list_directory", ...}").
  // Requiring the whole line (not just any substring) keeps this from matching a
  // JSON example quoted mid-sentence; `tryParseToolCallJson`'s strict shape check
  // plus the registered-tool-name requirement further guard against false positives.
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    candidates.push({ matchedText: trimmed, jsonText: trimmed })
  }
  for (const line of text.split('\n')) {
    const trimmedLine = line.trim()
    if (trimmedLine.startsWith('{') && trimmedLine.endsWith('}') && trimmedLine !== trimmed) {
      candidates.push({ matchedText: trimmedLine, jsonText: trimmedLine })
    }
  }
  const trailingJson = extractTrailingJsonObject(text)
  if (trailingJson) candidates.push(trailingJson)

  return candidates
}

/**
 * See `DEEPSEEK_CALL`. One candidate per leaked call.
 *
 * `matchedText` deliberately runs from the call marker to the end of the
 * response rather than stopping at the closing fence. Everything the model
 * writes past a leaked call is a continuation reasoned on a tool result it
 * never received — in the observed turn, literal `<｜tool▁output▁begin｜>`
 * blocks holding invented file contents. Only the text *before* the first
 * leaked call was written with real information, so that is all that survives
 * into the reply; the recovered call then runs for real and the caller
 * re-prompts with its actual result.
 */
function extractDeepSeekCandidates(text: string): Candidate[] {
  const candidates: Candidate[] = []

  for (const match of text.matchAll(DEEPSEEK_CALL)) {
    candidates.push({
      matchedText: text.slice(match.index),
      jsonText: JSON.stringify({
        name: match[1],
        arguments: parseJsonLoosely(match[2].trim()) ?? {}
      })
    })
  }

  return candidates
}

/** See `FUNCTION_TAG`. One candidate per `<function=…>` block found. */
function extractFunctionTagCandidates(text: string): Candidate[] {
  const candidates: Candidate[] = []

  for (const match of text.matchAll(FUNCTION_TAG)) {
    const tagStart = match.index
    const bodyStart = tagStart + match[0].length

    // The block ends at whichever comes first: an explicit close, the next
    // function tag, or the end of the text.
    let bodyEnd = text.length
    for (const marker of ['<function=', '</function>']) {
      const found = text.indexOf(marker, bodyStart)
      if (found !== -1 && found < bodyEnd) bodyEnd = found
    }

    const args: Record<string, string> = {}
    for (const parameter of text.slice(bodyStart, bodyEnd).matchAll(PARAMETER_BLOCK)) {
      args[parameter[1]] = parameter[2].trim()
    }

    // Widen the span over the wrapper tags so `stripFallbackCall` removes them
    // too, rather than leaving bare `<tool_call>` fragments in the reply.
    const leading = LEADING_WRAPPER.exec(text.slice(0, tagStart))
    const trailing = TRAILING_WRAPPER.exec(text.slice(bodyEnd))
    candidates.push({
      matchedText: text.slice(
        tagStart - (leading?.[0].length ?? 0),
        bodyEnd + (trailing?.[0].length ?? 0)
      ),
      jsonText: JSON.stringify({ name: match[1], arguments: args })
    })
  }

  return candidates
}

function extractTrailingJsonObject(text: string): Candidate | null {
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '{') continue
    const end = balancedJsonObjectEnd(text, index)
    if (end === -1 || text.slice(end).trim()) continue
    const matchedText = text.slice(index, end)
    return { matchedText, jsonText: matchedText }
  }
  return null
}

function balancedJsonObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }

  return -1
}

/** Strictly parse `{"name": string, "arguments": object}`; anything else is not a tool call. */
function tryParseToolCallJson(
  text: string
): { name: string; arguments: Record<string, unknown> } | null {
  const value = parseJsonLoosely(text.trim())
  if (value === null || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string') return null
  if (record.arguments !== undefined && typeof record.arguments !== 'object') return null

  return { name: record.name, arguments: (record.arguments as Record<string, unknown>) ?? {} }
}

/**
 * Parse strictly first; if that fails, retry after repairing a common small-model
 * mistake — escaping a single quote with a backslash inside a double-quoted JSON
 * string (`\'`), which is valid in JS/Python string literals but not a recognized
 * JSON escape. Observed directly: a 7B model's `write_file` call broke this way
 * (`"...str.toUpperCase() + '!\';..."`), which silently failed `JSON.parse` and
 * left the call as inert text instead of being recovered.
 */
function parseJsonLoosely(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // fall through to the repair attempt
  }
  try {
    return JSON.parse(text.replace(/\\'/g, "'"))
  } catch {
    return null
  }
}

/** Remove a detected fallback call from the response, leaving only the model's natural-language commentary. */
export function stripFallbackCall(text: string, call: FallbackToolCall): string {
  return text.replace(call.matchedText, '').trim()
}

/**
 * Earliest point where streamed assistant text might be starting a raw tool
 * payload. The caller can stream everything before this point and hold the
 * rest until fallback detection has the complete response.
 */
export function findPotentialToolCallTextStart(text: string): number {
  const starts = [
    text.indexOf('<tool_call'),
    // Held back for the same reason as `<tool_call`: it can appear without one.
    text.indexOf('<function='),
    // Same reason: a leaked DeepSeek call is raw payload, not prose the user
    // should watch arrive.
    text.indexOf(DEEPSEEK_CALL_BEGIN),
    text.indexOf('```json'),
    text.indexOf('```\n{'),
    text.indexOf('``` \n{'),
    findToolishJsonStart(text)
  ].filter((index) => index >= 0)

  return starts.length > 0 ? Math.min(...starts) : -1
}

function findToolishJsonStart(text: string): number {
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '{') continue
    const previous = index === 0 ? '' : text[index - 1]
    if (previous && !/\s/.test(previous)) continue
    return index
  }
  return -1
}
