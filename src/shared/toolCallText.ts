export interface ToolCallTextMatch {
  name: string
  arguments: Record<string, unknown>
  matchedText: string
}

interface Candidate {
  matchedText: string
  jsonText: string
}

const TOOL_CALL_TAG = /<tool_call>([\s\S]*?)<\/tool_call>/gi
const JSON_FENCE = /```(?:json)?\s*\n?([\s\S]*?)```/gi
/** See the matching constant in `main/llama/toolCallFallback.ts` for why this exists. */
const SELF_CLOSING_TAG = /<([a-zA-Z][\w-]*)((?:\s+[\w-]+=(?:"[^"]*"|'[^']*'))+)\s*\/>/g
const TAG_ATTRIBUTE = /([\w-]+)=(?:"([^"]*)"|'([^']*)')/g

/**
 * Finds model-emitted tool-call JSON in ordinary assistant text. Accepts only
 * the strict `{"name": string, "arguments": object}` shape and only when the
 * tool name is known, so regular JSON examples stay visible.
 */
export function detectToolCallText(
  text: string,
  availableToolNames: ReadonlySet<string>
): ToolCallTextMatch | null {
  for (const { matchedText, jsonText } of extractCandidates(text)) {
    const parsed = tryParseToolCallJson(jsonText)
    if (parsed && availableToolNames.has(parsed.name)) {
      return { ...parsed, matchedText }
    }
  }
  return null
}

/** Remove every recognized raw tool-call payload from assistant text. */
export function stripToolCallText(text: string, availableToolNames: ReadonlySet<string>): string {
  let cleaned = text
  for (;;) {
    const match = detectToolCallText(cleaned, availableToolNames)
    if (!match) return cleaned.trim()
    cleaned = cleaned.replace(match.matchedText, '')
  }
}

/**
 * Earliest point where streamed assistant text may be starting a raw tool
 * payload. This is intentionally a little broader than full parsing so the UI
 * can quarantine partial JSON before it becomes a noisy visible blob.
 */
export function findPotentialToolCallTextStart(text: string): number {
  const starts = [
    text.indexOf('<tool_call'),
    text.indexOf('```json'),
    text.indexOf('```\n{'),
    text.indexOf('``` \n{'),
    findToolishJsonStart(text)
  ].filter((index) => index >= 0)

  return starts.length > 0 ? Math.min(...starts) : -1
}

function extractCandidates(text: string): Candidate[] {
  const candidates: Candidate[] = []

  for (const match of text.matchAll(TOOL_CALL_TAG)) {
    candidates.push({ matchedText: match[0], jsonText: match[1] })
  }
  for (const match of text.matchAll(JSON_FENCE)) {
    candidates.push({ matchedText: match[0], jsonText: match[1] })
  }
  for (const match of text.matchAll(SELF_CLOSING_TAG)) {
    const [matchedText, name, attrText] = match
    const args: Record<string, string> = {}
    for (const attr of attrText.matchAll(TAG_ATTRIBUTE)) {
      args[attr[1]] = attr[2] ?? attr[3] ?? ''
    }
    candidates.push({ matchedText, jsonText: JSON.stringify({ name, arguments: args }) })
  }

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

function findToolishJsonStart(text: string): number {
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '{') continue
    const previous = index === 0 ? '' : text[index - 1]
    if (previous && !/\s/.test(previous)) continue
    const tail = text.slice(index + 1).trimStart()
    if (tail === '') return index
    if ('"name"'.startsWith(tail) || tail.startsWith('"name"')) return index
  }
  return -1
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

const CODE_FENCE_RE = /```([a-zA-Z0-9_-]*)\s*\n?([\s\S]*?)```/g
const CODE_FENCE_MIN_CHARS = 80
/**
 * Fallback heuristic for a *bare* (no language tag) fence — brace/JS-ish
 * vocabulary. Deliberately narrow: an explicitly-tagged fence (```markdown,
 * ```xml, ```python, anything) never needs this — the model naming a
 * language at all is already the signal that it's a real content block, not
 * incidental backtick-quoting. Previously this narrowness lived in the
 * *language allowlist* instead (css/html/js/json/ts/tsx only), which meant
 * any other tagged language — observed directly: ```markdown for a README,
 * ```xml for an RSS feed — silently bypassed detection entirely. Only the
 * untagged-fence fallback needs a heuristic at all now.
 */
const CODE_LIKE_RE =
  /[{};]|\b(?:body|class|const|display|document|export|function|import|let|querySelector)\b/i
/** Matches when the user's own prompt explicitly asked to see code in chat. */
export const CODE_ONLY_REQUEST_RE =
  /\b(?:show|display|provide|give|send|explain|describe)\b[\s\S]{0,100}\b(?:code|css|example|html|javascript|js|snippet)\b/i

export function hasSubstantialCodeFence(text: string): boolean {
  for (const match of text.matchAll(CODE_FENCE_RE)) {
    const lang = match[1].trim()
    const body = match[2].trim()
    if (body.length < CODE_FENCE_MIN_CHARS) continue
    if (lang || CODE_LIKE_RE.test(body)) return true
  }
  return false
}

/**
 * Remove substantial file-edit-shaped code fences from a reply, keeping the
 * surrounding prose. Shared between the main-process generation path (the
 * live streamed reply) and the renderer's post-generation block reconciler
 * (`reconcileMessageBlocks`) — both need the exact same decision, or the
 * flat `content` string and the rendered block list drift out of sync with
 * each other (one stripped, the other not). Never strips when the user
 * explicitly asked to see code in chat.
 */
export function stripSubstantialCodeFences(text: string, userPrompt: string): string {
  if (CODE_ONLY_REQUEST_RE.test(userPrompt)) return text
  const stripped = text.replace(CODE_FENCE_RE, (match, lang: string, body: string) => {
    const trimmedBody = body.trim()
    if (trimmedBody.length < CODE_FENCE_MIN_CHARS) return match
    if (!lang.trim() && !CODE_LIKE_RE.test(trimmedBody)) return match
    return ''
  })
  return stripped.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Some chat templates (observed: node-llama-cpp's `Gemma4ChatWrapper`, used
 * for Gemma-family GGUFs) mark a hidden "thinking" segment with a special
 * token pair — an opening `<|channel>thought` and a closing `<channel|>` —
 * that the wrapper is supposed to consume internally, surfacing only the
 * segment's content (never the raw tags) to the caller. A model that doesn't
 * reproduce that exact token sequence byte-for-byte (observed directly with
 * a third-party Gemma fine-tune) can leave the wrapper unable to recognize a
 * malformed/mismatched marker as part of a real segment boundary, so it
 * falls through as literal visible text instead — `<channel|>`, `<channel>`,
 * and `</channel>` have all been seen leaking this way. Narrow on purpose:
 * only strips this exact known artifact shape, not anything angle-bracketed
 * in general, so real HTML/JSX the model legitimately writes is untouched.
 */
const LEAKED_CHANNEL_TOKEN_RE = /<\/?channel\|?>\n?/gi

export function stripLeakedChannelTokens(text: string): string {
  return text
    .replace(LEAKED_CHANNEL_TOKEN_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

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
