/**
 * An edit that failed because the model's picture of the file is out of date.
 *
 * Measured: a 4B model at an 8,192-token window wrote a `test_stats.py` with an
 * indentation error, then could not repair it. Its reads were refused by the
 * gathering guard — 76 of them — so it edited blind, and every attempt failed
 * with "the text to replace was not found" or "line N does not match
 * expectedFirstLine". Those failures are no-ops, so they never reset the
 * gathering streak, and the refusals continued until the run gave up reporting
 * that it could not read a file that was sitting in the workspace.
 *
 * The guard's premise is that the model already has what it is asking for.
 * These errors are Anodex's own evidence that it does not: they are raised
 * precisely when the file does not say what the model thought. Refusing the
 * read that would fix that is backwards, so a failure of this kind earns one
 * read back — see `TaskLedger.noteStaleView`.
 *
 * A distinct error type rather than matching on message text. The messages are
 * Anodex's own, so matching them would work today and rot the moment one is
 * reworded, with nothing failing to say so.
 */
export class StaleFileViewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleFileViewError'
  }
}

/** Whether this failure means the model needs to look at the file again. */
export function isStaleFileView(error: unknown): boolean {
  return error instanceof StaleFileViewError
}
