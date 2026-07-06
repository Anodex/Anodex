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
 * Also handles a related but distinct failure, one level worse than a malformed
 * call: the model doesn't attempt a tool call at all, it just *narrates* a file
 * change in prose ("Now let's add X to file.js: ```...```") and later claims the
 * change was made. There's no call artifact to recover here, so
 * `looksLikeUnactedIntent` instead flags the claim so the caller can nudge the
 * model to actually act (see `LlamaService.generate()`'s intent-nudge step).
 */

export interface FallbackToolCall {
  name: string
  arguments: Record<string, unknown>
  /** The exact substring of the response (including any tags/fences) to remove before display. */
  matchedText: string
}

const TOOL_CALL_TAG = /<tool_call>([\s\S]*?)<\/tool_call>/gi
const JSON_FENCE = /```(?:json)?\s*\n?([\s\S]*?)```/gi

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

  for (const match of text.matchAll(TOOL_CALL_TAG)) {
    candidates.push({ matchedText: match[0], jsonText: match[1] })
  }
  for (const match of text.matchAll(JSON_FENCE)) {
    candidates.push({ matchedText: match[0], jsonText: match[1] })
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

  return candidates
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

/** Language claiming a file change was made, checked only near the end of a reply. */
const COMPLETION_CLAIM_RE =
  /\bI(?:'ve| have)?\s+(?:added|updated|fixed|created|changed|modified|edited|wrote|rewritten|replaced)\b/i

/** How much of the tail of a reply to check for a completion claim. */
const INTENT_CHECK_WINDOW = 600

/**
 * True when the end of a reply claims a file was changed ("I've added...",
 * "I fixed..."). Checking only the tail (not requiring the whole reply be short
 * or fence-free) matches how these claims actually appear — usually as a closing
 * summary after a long, otherwise-harmless explanation. This is intentionally
 * permissive on its own; the caller is expected to only act on it when no
 * write/edit tool call actually succeeded this turn, which is what makes a false
 * positive here harmless (verified elsewhere), not what makes this pattern itself
 * precise.
 */
export function looksLikeUnactedIntent(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  return COMPLETION_CLAIM_RE.test(trimmed.slice(-INTENT_CHECK_WINDOW))
}

/**
 * Language claiming a tool-mediated *outcome* occurred — an approval, a denial,
 * or a passing/failing test or build — checked only near the end of a reply.
 * Distinct from `COMPLETION_CLAIM_RE`: that catches a first-person "I did X"
 * claim, this catches third-person/outcome narration describing something that
 * supposedly just happened. Observed directly: given a conversation that
 * already contained a real "denied by user" event from an earlier turn, a 7B
 * model later fabricated a fresh "The user denied adding the function"
 * sentence in a turn that made zero tool calls — inventing an event that never
 * happened *that* turn, distinct from falsely claiming its own success.
 * The test/build phrasing is untested-in-the-wild here but included by analogy
 * (a well-documented agentic-coding-assistant confabulation pattern) — narrow
 * enough to revisit if it never actually fires.
 */
const FABRICATED_OUTCOME_RE =
  /\b(?:the user|you)\s+(?:denied|rejected|declined|approved|allowed)\b|\b(?:the\s+)?(?:tests?|build|command)\s+(?:passed|failed|succeeded)\b/i

/**
 * True when the end of a reply describes an approval/denial/test-result outcome.
 * Like `looksLikeUnactedIntent`, this is intentionally permissive on its own —
 * the caller should only act on it when *no tool call of any kind* happened
 * this turn, since a truthful report of a real outcome from this same turn
 * would otherwise be flagged too.
 */
export function looksLikeFabricatedOutcome(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  return FABRICATED_OUTCOME_RE.test(trimmed.slice(-INTENT_CHECK_WINDOW))
}
