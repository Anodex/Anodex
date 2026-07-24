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
}

export function createAsyncMutex(): AsyncMutex {
  let tail: Promise<void> = Promise.resolve()
  return {
    acquire(): Promise<() => void> {
      const prior = tail
      let release!: () => void
      tail = new Promise<void>((resolve) => {
        release = resolve
      })
      return prior.then(() => release)
    }
  }
}
