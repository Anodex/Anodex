/**
 * A minimal FIFO async mutex. `acquire()` resolves with a `release` callback
 * once every prior acquisition has released, so callers run strictly one at a
 * time in request order.
 *
 * Used to serialize all access to the single loaded model (see `LlamaService`):
 * the local vision runtime is a `llama-server` started with `--parallel 1`, so
 * a second concurrent request would drop the connection mid-stream.
 */
export interface AsyncMutex {
  acquire(): Promise<() => void>
  /**
   * How many callers are queued behind the current holder, not counting it.
   *
   * Non-zero means somebody asked for the model and is being made to wait, which is
   * otherwise invisible from outside. A phone's chat queued behind an agent run's
   * turn looked, from the phone, exactly like a computer that had stopped answering.
   */
  waiting(): number
}

export function createAsyncMutex(): AsyncMutex {
  let tail: Promise<void> = Promise.resolve()
  let queued = 0
  let held = false
  return {
    acquire(): Promise<() => void> {
      const prior = tail
      let release!: () => void
      tail = new Promise<void>((resolve) => {
        release = resolve
      })
      queued += 1
      return prior.then(() => {
        queued -= 1
        held = true
        let released = false
        // Idempotent, as resolving a promise twice always was: a caller releasing in
        // both a `finally` and an error path must not mark a later holder as free.
        return () => {
          if (released) return
          released = true
          held = false
          release()
        }
      })
    },
    waiting(): number {
      // A caller handed the lock whose continuation has not run yet is about to hold
      // it, not waiting behind anyone.
      return held ? queued : Math.max(0, queued - 1)
    }
  }
}
