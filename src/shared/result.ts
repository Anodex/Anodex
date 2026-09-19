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

/**
 * What to show a person when a call fails.
 *
 * `AnodexError` carries two sentences and they are not interchangeable.
 * `message` is what the handler decided to call it, written before anything had
 * gone wrong — `'Could not send email.'` is the same three words for a rejected
 * address, a stale password and an attachment over the size limit. `detail` is
 * `toErrorMessage(error)`: whatever actually happened.
 *
 * Reading `message` alone is the mistake this exists to stop, and it was the
 * majority: 48 of 62 `notifyError` calls in the renderer showed the placeholder
 * and dropped the cause. It reads as a working error message, which is why it
 * survived — the sentence is grammatical, it is on the right screen, and it
 * describes every possible cause equally.
 *
 * Both, where there are both and they differ. `notifyError` has a title and a
 * body, and passing this as the body puts the headline in *neither* place if it
 * is dropped — so the pair is kept: 'Could not send email. Invalid login: 535
 * authentication failed' says what failed and why, and neither half says both.
 */
export function reasonFor(error: Pick<AnodexError, 'message' | 'detail'>): string {
  const headline = error.message?.trim()
  const cause = error.detail?.trim()

  if (!cause) return headline ?? ''
  if (!headline) return cause
  // A handler that passed the same string twice, and a detail the headline
  // already contains, are one sentence rather than two.
  if (cause === headline || headline.includes(cause)) return headline
  // Joined exactly as it was written, with no capital forced onto it.
  //
  // The first version of this uppercased the cause so the pair read as two
  // sentences, which is fine for prose and wrong for everything else a
  // `detail` actually contains: `video.mov takes this past 18 MB` became
  // `Video.mov`, and `getaddrinfo ENOTFOUND …` would become `Getaddrinfo`.
  // Filenames, hostnames and command names are the common case here, and
  // renaming one in an error message is worse than a lowercase letter after
  // a full stop. The whole point of this function is to repeat what the other
  // end said; editing it is not repeating it.
  return `${headline} ${cause}`
}
