import { EventEmitter } from 'node:events'
import type { HistoryCompactionEvent } from '@shared/chat.types'

/**
 * Provider-neutral chat event bus. `LlamaService` already emits
 * `historyCompacted` for the local engine (it owns a real session/context to
 * react to); cloud providers have no engine object of their own, so
 * `runGeneration.ts` emits the same event shape here instead. Both feed the
 * identical IPC channel (see `main/ipc/index.ts`), so the renderer's handling
 * in `chatStore.ts` is provider-agnostic.
 */
class ChatEventBus extends EventEmitter {
  emitHistoryCompacted(event: HistoryCompactionEvent): void {
    this.emit('historyCompacted', event)
  }
}

export const chatEvents = new ChatEventBus()
