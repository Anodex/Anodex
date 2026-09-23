/**
 * A deadline for silence on a streaming response.
 *
 * ## The failure
 *
 * llama-server wedged mid-run: its slot reported `is_processing` forever on a
 * 290-token task, decoding nothing, its task id frozen across samples. Anodex
 * waited **nineteen minutes** and would have waited indefinitely, because the
 * request's own fifteen-minute timeout could not fire — the OpenAI SDK's
 * `timeout` bounds getting the response, and once the stream is open and
 * `for await` is consuming it, nothing bounds the gaps between chunks.
 *
 * That took the whole app with it, not just the turn. `llamaService.
 * isGenerating()` stayed true, so the Scheduler logged "task(s) due while a
 * foreground reply is generating — deferring to a later tick" every thirty
 * seconds and never ran anything again.
 *
 * ## What this does
 *
 * Aborts the request when no chunk has arrived for `SILENCE_LIMIT_MS`. Not a
 * cap on how long a response may take — a long one keeps sending chunks and
 * keeps resetting the clock. Only complete silence counts, which is the one
 * thing a working server never does.
 *
 * ## What it does not cover
 *
 * Only silence. If a wedged llama-server kept sending something — an SSE
 * keep-alive, an empty delta — every chunk would restart the clock and this
 * would never fire. The observed wedge sent nothing at all (no round
 * completed, and no prompt-progress chunk arrived either, which that build
 * streams during a read), so silence is the shape that was actually seen. A
 * wedge that chatters would need a different signal: no *tokens* for a while
 * rather than no chunks. Not built, because it has not been observed, and a
 * token-based deadline would have to be told apart from a long prompt read.
 *
 * The limit is deliberately far above any legitimate gap. The longest real one
 * is reading a cold prompt before the first token: about three minutes even
 * for a 128k window at the ~700 tok/s this hardware manages, and llama-server
 * streams progress during that read anyway (`return_progress`). It is equally
 * far below the nineteen minutes observed, so a wedge is caught while a slow
 * reply is not.
 */

/** How long a stream may say nothing at all before it is abandoned. */
export const SILENCE_LIMIT_MS = 5 * 60_000

export interface StreamStallWatch {
  /** Pass to the request; aborts on the caller's signal or on silence. */
  readonly signal: AbortSignal
  /** Call for every chunk received — restarts the clock. */
  heard(): void
  /** Whether this watch, rather than the caller, ended the request. */
  readonly stalled: boolean
  /** Always call when the stream ends, however it ends. */
  done(): void
}

/**
 * Watch a stream for silence.
 *
 * `caller` is the turn's own abort signal, if it has one; aborting it aborts
 * the request as before, and is reported as the caller's doing rather than a
 * stall.
 */
export function watchForStall(
  caller: AbortSignal | undefined,
  limitMs: number = SILENCE_LIMIT_MS,
  schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
  cancel: (handle: ReturnType<typeof setTimeout>) => void = clearTimeout
): StreamStallWatch {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stalled = false
  let finished = false

  const giveUp = (): void => {
    if (finished) return
    stalled = true
    controller.abort()
  }

  const restart = (): void => {
    if (finished) return
    if (timer) cancel(timer)
    timer = schedule(giveUp, limitMs)
  }

  const stop = (): void => {
    finished = true
    if (timer) cancel(timer)
    timer = null
    stopListening()
  }

  // The caller's own abort still ends the request, and is not a stall.
  //
  // The listener is removed by `done()`, not left to `{ once: true }` alone.
  // One watch is created per round and they all listen to the same turn-long
  // signal, so a listener that is never fired is a listener that accumulates:
  // forty-eight rounds would leave forty-eight of them and Node starts warning
  // about a leak past ten.
  const relay = (): void => controller.abort()
  if (caller) {
    if (caller.aborted) controller.abort()
    else caller.addEventListener('abort', relay, { once: true })
  }
  const stopListening = (): void => caller?.removeEventListener('abort', relay)
  restart()

  return {
    signal: controller.signal,
    heard: restart,
    get stalled() {
      return stalled
    },
    done: stop
  }
}

/** What the turn reports when a stream went silent. */
export function describeStall(limitMs: number = SILENCE_LIMIT_MS): string {
  const minutes = Math.round(limitMs / 60_000)
  return (
    `The local runtime stopped responding — nothing arrived for ${minutes} minutes, ` +
    'so the request was abandoned. The model may need reloading.'
  )
}
