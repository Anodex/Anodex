import type { ToolCall } from '@shared/tools.types'

/** One message's accumulated, not-yet-flushed token text. */
export interface PendingTokenEntry {
  conversationId: string
  text: string
}

/** One message's accumulated, not-yet-flushed tool-activity calls, in arrival order. */
export interface PendingActivityEntry {
  conversationId: string
  calls: Map<string, ToolCall>
}

/**
 * Accumulates per-message token/thinking-token text and tool-activity events
 * between flushes, so a caller (see `useAnodexBridge.ts`) can commit far
 * fewer, larger chat-store updates than the number of raw IPC events actually
 * received — see that file's doc comment on `scheduleTokenFlush` for why:
 * MessageBubble's render pipeline reprocesses a message's full, ever-growing
 * block list from scratch on every commit, and a long bounded-chat reply can
 * emit far more raw tokens AND tool-activity events per second (a model
 * calling many read-only tools back to back with little text between them)
 * than the display could ever show anyway.
 *
 * Deliberately has no notion of *when* to flush (no timer, no
 * `requestAnimationFrame`) — that scheduling is the caller's job, kept out
 * of this class so the accumulation logic itself stays a plain, synchronous,
 * fully unit-testable data structure.
 */
export class TokenBatcher {
  private tokens = new Map<string, PendingTokenEntry>()
  private thinkingTokens = new Map<string, PendingTokenEntry>()
  private activity = new Map<string, PendingActivityEntry>()

  addToken(conversationId: string, messageId: string, token: string): void {
    appendTo(this.tokens, conversationId, messageId, token)
  }

  addThinkingToken(conversationId: string, messageId: string, token: string): void {
    appendTo(this.thinkingTokens, conversationId, messageId, token)
  }

  /**
   * A repeat call for the same `call.id` (e.g. running → success) overwrites
   * the earlier one but keeps its original position in iteration order —
   * `Map.set` on an existing key doesn't move it — so a status update stays
   * in its original chronological slot while a genuinely new call lands
   * after everything already buffered, same ordering `applyToolActivity`
   * itself relies on.
   */
  addToolActivity(conversationId: string, messageId: string, call: ToolCall): void {
    let entry = this.activity.get(messageId)
    if (!entry) {
      entry = { conversationId, calls: new Map() }
      this.activity.set(messageId, entry)
    }
    entry.calls.set(call.id, call)
  }

  hasPending(): boolean {
    return this.tokens.size > 0 || this.thinkingTokens.size > 0 || this.activity.size > 0
  }

  /** Drains everything accumulated so far and clears state — call once per flush. */
  drain(): {
    tokens: Array<[messageId: string, entry: PendingTokenEntry]>
    thinkingTokens: Array<[messageId: string, entry: PendingTokenEntry]>
    activity: Array<[messageId: string, conversationId: string, calls: ToolCall[]]>
  } {
    const tokens = [...this.tokens]
    const thinkingTokens = [...this.thinkingTokens]
    const activity: Array<[string, string, ToolCall[]]> = [...this.activity].map(
      ([messageId, entry]) => [messageId, entry.conversationId, [...entry.calls.values()]]
    )
    this.tokens.clear()
    this.thinkingTokens.clear()
    this.activity.clear()
    return { tokens, thinkingTokens, activity }
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
