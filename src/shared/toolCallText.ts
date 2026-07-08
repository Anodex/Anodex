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

function extractCandidates(text: string): Candidate[] {
  const candidates: Candidate[] = []

  for (const match of text.matchAll(TOOL_CALL_TAG)) {
    candidates.push({ matchedText: match[0], jsonText: match[1] })
  }
  for (const match of text.matchAll(JSON_FENCE)) {
    candidates.push({ matchedText: match[0], jsonText: match[1] })
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
