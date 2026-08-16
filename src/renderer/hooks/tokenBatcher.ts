import type { ToolCall } from '@shared/tools.types'
import type { ChatStreamEvent } from '../features/chat/streamEvents'

/** One message's accumulated, not-yet-flushed events in arrival order. */
export interface PendingStreamEntry {
  conversationId: string
  events: ChatStreamEvent[]
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
  private pending = new Map<string, PendingStreamEntry>()

  addToken(conversationId: string, messageId: string, token: string): void {
    appendTextEvent(this.entry(conversationId, messageId).events, 'text', token)
  }

  addThinkingToken(conversationId: string, messageId: string, token: string): void {
    appendTextEvent(this.entry(conversationId, messageId).events, 'thinking', token)
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
    const events = this.entry(conversationId, messageId).events
    for (const event of events) {
      if (event.type !== 'activity') continue
      const callIndex = event.calls.findIndex((candidate) => candidate.id === call.id)
      if (callIndex >= 0) {
        event.calls[callIndex] = call
        return
      }
    }

    const last = events[events.length - 1]
    if (last?.type === 'activity') last.calls.push(call)
    else events.push({ type: 'activity', calls: [call] })
  }

  hasPending(): boolean {
    return this.pending.size > 0
  }

  /** Drains everything accumulated so far and clears state — call once per flush. */
  drain(): Array<[messageId: string, entry: PendingStreamEntry]> {
    const pending = [...this.pending]
    this.pending.clear()
    return pending
  }

  private entry(conversationId: string, messageId: string): PendingStreamEntry {
    let entry = this.pending.get(messageId)
    if (!entry) {
      entry = { conversationId, events: [] }
      this.pending.set(messageId, entry)
    }
    return entry
  }
}

function appendTextEvent(
  events: ChatStreamEvent[],
  type: 'text' | 'thinking',
  token: string
): void {
  const last = events[events.length - 1]
  if (last?.type === type) last.text += token
  else events.push({ type, text: token })
}
