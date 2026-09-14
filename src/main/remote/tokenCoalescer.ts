/**
 * How long tokens for a phone are held before they are sent together.
 *
 * A local model writes forty tokens a second, and one frame per token cost a phone
 * about 330 bytes each once TCP, TLS and the frame's own envelope were counted — a
 * two-hundred-word reply with its thinking came to 370KB and twelve hundred packets.
 * Twelve frames a second still reads as a reply being written, and each carries three
 * or four tokens for one frame's overhead.
 */
export const TOKEN_FLUSH_MS = 80

/** Sent at once past this much held text, so one frame never grows large. */
const MAX_HELD_CHARS = 16_000

/** The channels whose frames are one token each, and so worth holding. */
const TOKEN_CHANNELS = new Set(['chat:stream', 'chat:thinking-stream'])

interface Held {
  channel: string
  conversationId: string
  messageId: string
  token: string
}

export interface TokenCoalescer {
  /** Send an event, or hold it to go out with the next few tokens. */
  event(channel: string, payload: unknown): void
  /** Send everything held, in order. Called before any other frame goes out. */
  flush(): void
  /** Drop anything held. The socket has gone. */
  dispose(): void
}

/**
 * Join a phone's token frames into fewer, larger ones.
 *
 * Only consecutive tokens for the same turn on the same channel are joined, and
 * anything else — a tool starting, an approval, a turn's result — sends what is held
 * first. So the phone receives exactly the text it did before, in exactly the order,
 * in fewer pieces. A frame joined this way is shaped like a single token's, which is
 * why a phone from before this reads it without knowing anything changed.
 */
export function createTokenCoalescer(options: {
  emit: (channel: string, payload: unknown) => void
  flushMs?: number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}): TokenCoalescer {
  const flushMs = options.flushMs ?? TOKEN_FLUSH_MS
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let held: Held[] = []
  let heldChars = 0
  let timer: unknown = null

  const flush = (): void => {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    if (held.length === 0) return
    const out = held
    held = []
    heldChars = 0
    for (const { channel, conversationId, messageId, token } of out) {
      options.emit(channel, { conversationId, messageId, token })
    }
  }

  return {
    event(channel, payload) {
      const token = tokenOf(channel, payload)
      if (!token) {
        flush()
        options.emit(channel, payload)
        return
      }

      const last = held.at(-1)
      if (
        last &&
        last.channel === token.channel &&
        last.conversationId === token.conversationId &&
        last.messageId === token.messageId
      ) {
        last.token += token.token
      } else {
        held.push(token)
      }
      heldChars += token.token.length

      if (heldChars >= MAX_HELD_CHARS) flush()
      else if (timer === null) timer = setTimer(flush, flushMs)
    },
    flush,
    dispose() {
      if (timer !== null) clearTimer(timer)
      timer = null
      held = []
      heldChars = 0
    }
  }
}

/**
 * A payload that is exactly one token, or null.
 *
 * Exactly: anything carrying more than the three fields — the thinking so far sent
 * with `replace` when a phone opens it — means something a joined frame would lose.
 */
function tokenOf(channel: string, payload: unknown): Held | null {
  if (!TOKEN_CHANNELS.has(channel) || typeof payload !== 'object' || payload === null) return null
  const fields = payload as Record<string, unknown>
  if (Object.keys(fields).length !== 3) return null
  const { conversationId, messageId, token } = fields
  if (typeof conversationId !== 'string' || typeof messageId !== 'string') return null
  if (typeof token !== 'string') return null
  return { channel, conversationId, messageId, token }
}
