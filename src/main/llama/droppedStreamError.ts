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
