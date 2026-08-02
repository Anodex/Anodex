/**
 * Detects llama.cpp's signature for a tool call whose arguments were still
 * incomplete when generation ended.
 *
 * llama-server parses the model's tool-call arguments itself (`--jinja`). If
 * the JSON is unterminated — the model stopped mid-string, mid-object, or ran
 * out of room — that parse throws and the server answers HTTP 500 with the
 * C++ exception text, aborting the whole request. Nothing in the reply is
 * salvageable through the normal streaming path, so the transport has to
 * recognize this shape to recover from it instead of failing the turn.
 *
 * Deliberately narrow: it must not match a tool call that merely *executed*
 * badly, only one that was cut off before it was fully emitted.
 *
 * Kept dependency-free so the provider (error form) and any message-only
 * consumer can share one definition, matching `droppedStreamError.ts`.
 */

/**
 * The parser message llama.cpp raises for an unfinished arguments payload. The
 * nlohmann detail that follows it ("missing closing quote", "unexpected end of
 * input", …) varies by where generation stopped, so only the stable prefix is
 * matched.
 */
const TRUNCATED_ARGUMENTS_PATTERN = /failed to parse tool call arguments as json/i

/**
 * A second llama.cpp phrasing for the same condition, raised when the tool-call
 * block itself (rather than its arguments) never closed.
 */
const UNCLOSED_TOOL_CALL_PATTERN = /unclosed .{0,24}tool.?call|incomplete tool call/i

export function isTruncatedToolCallMessage(message: string): boolean {
  return TRUNCATED_ARGUMENTS_PATTERN.test(message) || UNCLOSED_TOOL_CALL_PATTERN.test(message)
}

export function isTruncatedToolCallError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (isTruncatedToolCallMessage(error.message)) return true
  const cause = (error as { cause?: unknown }).cause
  return cause instanceof Error && isTruncatedToolCallMessage(cause.message)
}

/**
 * What the model had emitted when it was cut off, recovered from the parse
 * error's own text (llama.cpp echoes the unterminated payload after
 * `last read:`). Returned purely for logging and for telling the user how far
 * the call got — never to be repaired and executed.
 *
 * Repairing it would mean closing the dangling string and running the call
 * anyway, which for a `write_file` means writing a silently half-finished
 * file and reporting success. A visible failure is strictly better than a
 * corrupt artifact, and the surrounding code depends on that invariant.
 */
export function truncatedArgumentsPreview(error: unknown, maxChars = 200): string | undefined {
  if (!(error instanceof Error)) return undefined
  const match = /last read: '(.*)$/is.exec(error.message)
  const payload = match?.[1]?.trim()
  if (!payload) return undefined
  return payload.length > maxChars ? `${payload.slice(0, maxChars)}…` : payload
}
