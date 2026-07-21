/** One message's accumulated, not-yet-flushed token text. */
export interface PendingTokenEntry {
  conversationId: string
  text: string
}

/**
 * Accumulates per-message token/thinking-token text between flushes, so a
 * caller (see `useAnodexBridge.ts`) can commit far fewer, larger chat-store
 * updates than the number of raw IPC token events actually received — see
 * that file's doc comment on `scheduleTokenFlush` for why: MessageBubble's
 * render pipeline reprocesses a message's full, ever-growing block list from
 * scratch on every commit, and a long bounded-chat reply can emit far more
 * raw tokens per second than the display could ever show anyway.
 *
 * Deliberately has no notion of *when* to flush (no timer, no
 * `requestAnimationFrame`) — that scheduling is the caller's job, kept out
 * of this class so the accumulation logic itself stays a plain, synchronous,
 * fully unit-testable data structure.
 */
export class TokenBatcher {
  private tokens = new Map<string, PendingTokenEntry>()
  private thinkingTokens = new Map<string, PendingTokenEntry>()

  addToken(conversationId: string, messageId: string, token: string): void {
    appendTo(this.tokens, conversationId, messageId, token)
  }

  addThinkingToken(conversationId: string, messageId: string, token: string): void {
    appendTo(this.thinkingTokens, conversationId, messageId, token)
  }

  hasPending(): boolean {
    return this.tokens.size > 0 || this.thinkingTokens.size > 0
  }

  /** Drains everything accumulated so far and clears state — call once per flush. */
  drain(): {
    tokens: Array<[messageId: string, entry: PendingTokenEntry]>
    thinkingTokens: Array<[messageId: string, entry: PendingTokenEntry]>
  } {
    const tokens = [...this.tokens]
    const thinkingTokens = [...this.thinkingTokens]
    this.tokens.clear()
    this.thinkingTokens.clear()
    return { tokens, thinkingTokens }
  }
}

function appendTo(
  map: Map<string, PendingTokenEntry>,
  conversationId: string,
  messageId: string,
  token: string
): void {
  const existing = map.get(messageId)
  map.set(messageId, { conversationId, text: (existing?.text ?? '') + token })
}
