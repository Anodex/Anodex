/**
 * A single owned timer for the deferred model restore at startup.
 *
 * Both paths that can reach `restoreLastModel` — the bridge effect on mount,
 * and `retryStartup` from the startup overlay's "Try again" — schedule it after
 * a delay. The mount path learned to own its timer the hard way: an untracked
 * `setTimeout` survived the effect's cleanup, so React StrictMode's
 * mount/cleanup/re-mount fired the restore twice, and two concurrent
 * `loadModel()` calls raced to allocate the same GPU and model resources. That
 * was the intermittent native startup crash.
 *
 * `retryStartup` was left scheduling its own bare `setTimeout`, which nothing
 * could cancel — so a retry that succeeded seconds before the window closed
 * still started a model load into a shutting-down app, and a second scheduled
 * restore could overlap a first.
 *
 * One handle, shared: scheduling again replaces whatever was pending, and
 * cancelling stops it. That makes a duplicate schedule a no-op rather than a
 * second real load, wherever it comes from.
 */
export class DeferredRestore {
  private handle: ReturnType<typeof setTimeout> | undefined

  /** Replace any pending restore with a new one `delayMs` from now. */
  schedule(run: () => void, delayMs: number): void {
    this.cancel()
    this.handle = setTimeout(() => {
      this.handle = undefined
      run()
    }, delayMs)
  }

  cancel(): void {
    if (this.handle === undefined) return
    clearTimeout(this.handle)
    this.handle = undefined
  }

  /** Whether a restore is currently waiting to run. Exposed for tests. */
  get pending(): boolean {
    return this.handle !== undefined
  }
}

/**
 * Shared by the bridge effect and `retryStartup`, which are different call
 * sites reaching the same single-model engine.
 */
export const deferredModelRestore = new DeferredRestore()
