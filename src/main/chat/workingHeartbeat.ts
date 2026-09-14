import type { ChatWorkingEvent, PromptReadingProgress } from '@shared/chat.types'

/**
 * How often a turn nobody can see progress on says it is still alive.
 *
 * Well inside the phone's own patience — it gives a silent turn five minutes — and
 * rare enough to cost nothing on a socket that is already carrying tokens.
 */
export const WORKING_HEARTBEAT_MS = 30_000

export interface WorkingHeartbeat {
  /** Something visible happened: a token, a thought, a tool. */
  touch(): void
  /**
   * The model is reading the prompt, this far. Sent straight away rather than on the
   * heartbeat's schedule — it is the one quiet stretch worth watching move.
   */
  reading(progress: PromptReadingProgress): void
  stop(): void
}

/**
 * Keep a remote client told that a turn is still going, and why it is quiet.
 *
 * A turn can be silent for a long time while being perfectly healthy: queued
 * behind an agent run that holds the model, or thinking with live tokens switched
 * off. The phone could not tell either apart from a computer that had died, gave up
 * after five minutes, and said so — and the question it had sent was never answered
 * anywhere it could see.
 *
 * So while a turn runs, any 30-second stretch with nothing else sent produces one
 * `chat:working` event. It says `waiting-for-model` while the turn has not started
 * and something else is holding the model, and `working` otherwise. The first one
 * goes out at once when the turn arrives to find the model busy, so the phone can
 * say "waiting" from the start rather than after half a minute of "thinking".
 */
export function startWorkingHeartbeat(options: {
  conversationId: string
  messageId: string
  send: (event: ChatWorkingEvent) => void
  /** Whether this turn is queued behind other work on the model right now. */
  waitingForModel: () => boolean
  intervalMs?: number
  now?: () => number
  setInterval?: (callback: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}): WorkingHeartbeat {
  const interval = options.intervalMs ?? WORKING_HEARTBEAT_MS
  const now = options.now ?? Date.now
  const schedule = options.setInterval ?? ((callback, ms) => setInterval(callback, ms))
  const cancel =
    options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))

  const since = now()
  let lastSent = since
  let started = false
  let stopped = false

  const emit = (): void => {
    lastSent = now()
    options.send({
      conversationId: options.conversationId,
      messageId: options.messageId,
      phase: !started && options.waitingForModel() ? 'waiting-for-model' : 'working',
      since
    })
  }

  if (options.waitingForModel()) emit()

  const handle = schedule(() => {
    if (stopped) return
    if (now() - lastSent >= interval) emit()
  }, interval)

  return {
    touch(): void {
      started = true
      lastSent = now()
    },
    reading(progress: PromptReadingProgress): void {
      if (stopped) return
      started = true
      lastSent = now()
      options.send({
        conversationId: options.conversationId,
        messageId: options.messageId,
        phase: 'reading',
        since,
        reading: progress
      })
    },
    stop(): void {
      if (stopped) return
      stopped = true
      cancel(handle)
    }
  }
}
