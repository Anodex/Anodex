/**
 * Detects Node `undici`'s signature for a streamed HTTP response whose
 * connection dropped mid-flight. For Anodex's local vision path this is what
 * surfaces when the private llama-server process dies while a reply is still
 * streaming — most often an out-of-memory kill. On a loopback connection to our
 * own subprocess an ordinary network blip is not a realistic alternative, so it
 * is safe to treat as a runtime stop.
 *
 * Kept dependency-free so both the provider (error form) and the IPC layer
 * (message form) can share one definition without pulling in Electron/OpenAI.
 */

/**
 * Message form: matches the bare `terminated` that `undici` throws, or an
 * explicit socket drop. Matched precisely so ordinary prose that merely
 * contains the word "terminated" is never misclassified.
 */
export function isDroppedStreamMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase()
  return (
    normalized === 'terminated' ||
    normalized.includes('other side closed') ||
    normalized.includes('und_err_socket') ||
    normalized.includes('econnreset')
  )
}

/**
 * llama-server's report that the context pool had no room for the next token.
 *
 * Not a runtime fault: the turn's context filled up while it ran. On a later round
 * that is exactly what compacting and carrying on in a fresh context handles, so it
 * is told apart from a crash rather than ending the reply as a provider failure.
 */
export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.toLowerCase().includes('context size has been exceeded')
}

/**
 * Error form: checks the error's own message and `undici`'s wrapped `.cause`
 * (where the underlying socket error — code and message — actually lives).
 */
export function isDroppedStreamError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (isDroppedStreamMessage(error.message)) return true
  const cause = (error as { cause?: unknown }).cause
  const causeCode = (cause as { code?: string } | undefined)?.code
  if (causeCode === 'UND_ERR_SOCKET' || causeCode === 'ECONNRESET') return true
  return cause instanceof Error && isDroppedStreamMessage(cause.message)
}
