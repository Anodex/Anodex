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

/**
 * Optional observer for every failure returned across the IPC boundary.
 *
 * Handlers catch their own errors and return `err(...)`, so a wrapper around
 * `ipcMain.handle` would never see the throw — this is the only choke point that
 * sees all of them. The main process attaches the diagnostics reporter here at
 * startup (see `src/main/diagnostics`), which is what keeps a failure like "the
 * model wouldn't load" from reaching the user as a bare sentence with nothing
 * behind it. Injected rather than imported because this module is shared with
 * the renderer, which must not pull in main-process code.
 */
export type ResultErrorReporter = (error: AnodexError) => void

let reporter: ResultErrorReporter | null = null
let reporting = false

/** Attach (or with `null`, detach) the failure observer. */
export function setResultErrorReporter(next: ResultErrorReporter | null): void {
  reporter = next
}

export function err(code: string, message: string, detail?: string): Result<never> {
  const error: AnodexError = { code, message, detail }
  // `reporting` guards against a reporter that itself fails through `err`.
  if (reporter && !reporting) {
    reporting = true
    try {
      reporter(error)
    } catch {
      // Observing a failure must never turn into a second one.
    } finally {
      reporting = false
    }
  }
  return { ok: false, error }
}

/** Narrow an unknown thrown value into a stable error message string. */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'An unexpected error occurred.'
}
