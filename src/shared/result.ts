/**
 * A small, explicit result type used across the IPC boundary.
 *
 * Rather than throwing across `ipcRenderer.invoke` (where stack traces and error
 * types are lost), main-process handlers return a `Result<T>`. The renderer then
 * has a typed, predictable shape to branch on — never an unexpected throw.
 */

export interface AnodexError {
  /** Stable, machine-readable identifier, e.g. `model.load-failed`. */
  code: string
  /** Human-readable, user-facing message. */
  message: string
  /** Optional technical detail for logs / debugging surfaces. */
  detail?: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AnodexError }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function err(code: string, message: string, detail?: string): Result<never> {
  return { ok: false, error: { code, message, detail } }
}

/** Narrow an unknown thrown value into a stable error message string. */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'An unexpected error occurred.'
}
