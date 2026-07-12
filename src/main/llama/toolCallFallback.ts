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
 * Also handles related but distinct failures one level worse than a malformed
 * call: the model doesn't attempt a tool call at all, it narrates a file change
 * in prose ("Now let's add X to file.js: ```...```") or later claims the change
 * was made. There's no call artifact to recover here, so the detectors below
 * flag the reply so the caller can nudge the model to actually act (see
 * `LlamaService.generate()`'s intent-nudge step).
 */

import { CODE_ONLY_REQUEST_RE, hasSubstantialCodeFence } from '@shared/toolCallText'

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

/**
 * Broader than `FILE_ACTION_RE` below (which only covers file-edit verbs for
 * `looksLikeToolBypass`'s narrower purpose) — this also covers read/inspect
 * verbs, since a stalled turn is just as possible for "check git status" as
 * for "add a feature". Used against the *user's* prompt, not the reply.
 */
const ACTION_REQUEST_RE =
  /\b(?:add|create|edit|include|insert|modify|patch|put|replace|update|write|check|run|search|list|verify|test|fix|remember|delete|move|rename|refactor)\b/i

/**
 * True when the user's message asked for a concrete action and *no tool call
 * of any kind happened this turn* (the caller is expected to gate on this —
 * same discipline as `looksLikeUnactedIntent`/`looksLikeFabricatedOutcome`
 * above), and the reply isn't a genuine clarifying question. Deliberately
 * phrasing-agnostic on the reply itself: models have been observed avoiding
 * a real tool call while still sounding like something happened in at least
 * three distinct ways in the same long session — a bare "Let's add X"
 * announcement, a first-person "I've added X" claim (nominally covered by
 * `looksLikeUnactedIntent`, but that regex is narrow), and a passive/
 * third-person "X is now live" / "X has been updated" claim that matches
 * neither existing regex. Chasing each new phrasing with its own pattern is
 * a losing game — if the user asked for a checkable/actionable thing and
 * literally nothing was attempted, that's worth a nudge regardless of how
 * the reply is worded. The cost of a false positive here (a reply that
 * genuinely needed no tool call, e.g. "no change needed, X already does
 * that") is just one extra retry round, not a wrong action — the nudge
 * prompt explicitly allows declining plainly on retry.
 */
export function looksLikeStalledIntent(reply: string, userPrompt: string): boolean {
  const trimmed = reply.trim()
  if (!trimmed || trimmed.endsWith('?')) return false
  if (CODE_ONLY_REQUEST_RE.test(userPrompt)) return false
  return ACTION_REQUEST_RE.test(userPrompt)
}

const FILE_ACTION_RE =
  /\b(?:add|create|edit|include|insert|modify|patch|put|replace|update|write)\b/i
const FILE_TARGET_RE =
  /`?[\w./-]+\.(?:css|html|js|jsx|json|md|ts|tsx)`?|\b(?:css|html|javascript|js|file)\b/i

/**
 * True when a project-chat reply appears to give the user file-edit code in
 * chat instead of applying it through write/edit tools. Kept conservative:
 * require a substantial code fence plus edit/action language, and suppress the
 * warning when the user's prompt explicitly asks to see code in chat.
 */
export function looksLikeToolBypass(reply: string, userPrompt: string): boolean {
  const trimmedReply = reply.trim()
  if (!trimmedReply || CODE_ONLY_REQUEST_RE.test(userPrompt)) return false
  if (!FILE_ACTION_RE.test(trimmedReply) || !FILE_TARGET_RE.test(trimmedReply)) return false
  return hasSubstantialCodeFence(trimmedReply)
}

/**
 * A sentence opener that only makes sense as a *reply to something the user
 * just said* — an agreement with user feedback ("you're absolutely right"), a
 * concession ("good point"), or an apology ("my apologies", "sorry about
 * that"). Each is anchored to a sentence/line boundary (group 1) so the opener
 * itself (group 2) can be located precisely. The "you're right/correct" branch
 * only allows a short, fixed set of intensifiers between so it can't stretch
 * across an unrelated clause ("you're going to see the right side").
 */
const FABRICATED_USER_REPLY_RE =
  /((?:^|[\n.!?)]\s+))(you(?:'re| are)\s+(?:(?:absolutely|totally|completely|so|quite|100%|definitely|certainly|entirely|indeed|very)\s+)?(?:right|correct)\b|(?:good|great|fair)\s+(?:point|catch)\b|my\s+apolog(?:y|ies)\b|i\s+apologize\b|i'?m\s+sorry\b|apologies\b|sorry(?:,|\s+about|\s+for)\b|thanks?\s+(?:you\s+)?for\s+(?:the\s+|your\s+)?(?:feedback|catch|pointing|correcting|clarifying)\b)/gi

/**
 * Locate the point where an assistant reply stops talking to the user and
 * starts fabricating the user's *next turn* — the model asks the user a
 * question ("Want me to fix these?") and then, in the same generation, keeps
 * going as if the user had already answered ("You're absolutely right — let me
 * apply those fixes"), often proceeding to act on its own invented approval.
 *
 * Returns the index where the fabricated reply begins (so a caller can cut the
 * turn there, keeping the genuine question), or -1 if none is found.
 *
 * The discriminator is a real question earlier in the *same* generation: within
 * one assistant turn no new user input can have arrived, so a "responding to
 * you" opener (agreement/concession/apology) that appears *after* the assistant
 * has already put a question to the user is fabricated by construction. Gating
 * on a preceding question is what keeps a legitimate "you're right" — one that
 * answers the user's *original* prompt at the top of a turn — from matching.
 */
export function detectFabricatedUserTurn(text: string): number {
  const questionIdx = text.indexOf('?')
  if (questionIdx === -1) return -1

  FABRICATED_USER_REPLY_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FABRICATED_USER_REPLY_RE.exec(text)) !== null) {
    const openerStart = match.index + match[1].length
    if (openerStart > questionIdx) return openerStart
  }
  return -1
}

/** True when a reply fabricates the user's next turn (see {@link detectFabricatedUserTurn}). */
export function looksLikeFabricatedUserTurn(text: string): boolean {
  return detectFabricatedUserTurn(text) !== -1
}
