/**
 * Who may use the loaded model right now: several jobs at once, or one thing alone.
 *
 * A shared holder is a job that runs on the model — a reply, a title, a summary.
 * Up to `capacity` of them run together. An exclusive holder — loading or unloading
 * the model — waits for every job to finish and keeps new ones out until it is done,
 * because disposing a model under a running decode is a native crash, not an error.
 *
 * Strictly first come, first served: a job never overtakes a load that asked before
 * it, and a load never waits forever behind a stream of jobs that keep arriving.
 *
 * With capacity 1 this is exactly the single-model mutex it replaced.
 */
export interface ModelGate {
  /** Run one job. Resolves with `release` once there is room. */
  acquire(): Promise<() => void>
  /** Have the model to yourself. Resolves with `release` once every job has left. */
  acquireExclusive(): Promise<() => void>
  /**
   * How many callers are queued, not counting those holding the gate.
   *
   * Non-zero means somebody asked for the model and is being made to wait, which is
   * otherwise invisible from outside. A phone's chat queued behind an agent run's
   * turn looked, from the phone, exactly like a computer that had stopped answering.
   */
  waiting(): number
  /** How many jobs may run at once. Changing it lets queued jobs in straight away. */
  setCapacity(capacity: number): void
  readonly capacity: number
}

interface Waiter {
  exclusive: boolean
  grant: (release: () => void) => void
}

export function createModelGate(initialCapacity = 1): ModelGate {
  let capacity = Math.max(1, Math.floor(initialCapacity))
  let shared = 0
  let exclusive = false
  const queue: Waiter[] = []

  const releaser = (onRelease: () => void): (() => void) => {
    let released = false
    // Idempotent: a caller releasing in both a `finally` and an error path must not
    // free a slot a later holder is using.
    return () => {
      if (released) return
      released = true
      onRelease()
      pump()
    }
  }

  function pump(): void {
    while (queue.length > 0) {
      const next = queue[0]
      if (next.exclusive) {
        if (exclusive || shared > 0) return
        queue.shift()
        exclusive = true
        next.grant(
          releaser(() => {
            exclusive = false
          })
        )
      } else {
        if (exclusive || shared >= capacity) return
        queue.shift()
        shared += 1
        next.grant(
          releaser(() => {
            shared -= 1
          })
        )
      }
    }
  }

  function enqueue(isExclusive: boolean): Promise<() => void> {
    return new Promise((resolve) => {
      queue.push({ exclusive: isExclusive, grant: resolve })
      pump()
    })
  }

  return {
    acquire: () => enqueue(false),
    acquireExclusive: () => enqueue(true),
    waiting: () => queue.length,
    setCapacity(next: number): void {
      capacity = Math.max(1, Math.floor(next))
      pump()
    },
    get capacity(): number {
      return capacity
    }
  }
}
