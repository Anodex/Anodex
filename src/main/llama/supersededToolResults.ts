import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

/** Tools whose result is a snapshot of a file at a moment in time. */
const TURN_SNAPSHOT_READS = new Set([
  'read_file',
  'read_file_range',
  'read_multiple_files',
  'code_outline'
])

/** Tools that change a file, invalidating every earlier read of it. */
const TURN_WRITE_TOOLS = new Set(['write_file', 'append_file', 'edit_file', 'replace_lines'])

const TURN_REPEATED_READ_NOTICE =
  '[superseded — this exact read was repeated later in this turn, and the newer copy is the one that reflects the file now]'

const TURN_STALE_AFTER_WRITE_NOTICE =
  '[superseded — this file was edited after this read, so these line numbers and this content no longer match what is on disk. Read it again before editing it.]'

/** The `path` a tool call names, when it names one. */
function toolCallPath(rawArguments: string): string | null {
  try {
    const parsed: unknown = JSON.parse(rawArguments)
    if (parsed && typeof parsed === 'object' && 'path' in parsed) {
      const path = parsed.path
      return typeof path === 'string' ? path : null
    }
  } catch {
    return null
  }
  return null
}

/**
 * Collapse superseded reads *within the turn being built*.
 *
 * `projectHistoryForModel` does this for replayed history, and for a long time
 * that looked like enough. It is not: a live run made 167 tool calls inside a
 * single turn, so every read and every write it did lived in this array and
 * never passed through that projection at all. Seven edits were rejected for
 * stale line numbers in exactly the window the fix did not cover.
 *
 * Same two rules as history, applied to the message array as it grows: an
 * identical read is replaced by its newest copy, and any read of a file is
 * replaced once that file has been written. Identity is the tool name plus its
 * raw arguments, so two different ranges of one file both survive — they are
 * different content, not a repeat.
 */
export function collapseSupersededToolResults(messages: ChatCompletionMessageParam[]): number {
  const callsById = new Map<string, { name: string; args: string }>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.tool_calls) continue
    for (const call of message.tool_calls) {
      if (call.type === 'function') {
        callsById.set(call.id, { name: call.function.name, args: call.function.arguments })
      }
    }
  }

  const newestSeen = new Set<string>()
  const writtenSince = new Set<string>()
  let collapsed = 0

  // Newest first, so a write is seen before the reads it invalidates.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'tool') continue
    const call = callsById.get(message.tool_call_id)
    if (!call) continue

    if (TURN_WRITE_TOOLS.has(call.name)) {
      const path = toolCallPath(call.args)
      if (path) writtenSince.add(path)
      continue
    }
    if (!TURN_SNAPSHOT_READS.has(call.name)) continue
    // Never collapse a result that is already a marker, or the count inflates
    // every round and the notice stacks on itself.
    const existing = typeof message.content === 'string' ? message.content : ''
    if (existing.startsWith('[superseded —')) continue

    const path = toolCallPath(call.args)
    if (path && writtenSince.has(path)) {
      messages[index] = { ...message, content: TURN_STALE_AFTER_WRITE_NOTICE }
      collapsed++
      continue
    }
    const identity = `${call.name}::${call.args}`
    if (newestSeen.has(identity)) {
      messages[index] = { ...message, content: TURN_REPEATED_READ_NOTICE }
      collapsed++
    } else {
      newestSeen.add(identity)
    }
  }
  return collapsed
}
