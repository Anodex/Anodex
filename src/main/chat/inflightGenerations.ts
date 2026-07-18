/**
 * Tracks in-flight chat generations by conversation id, independent of
 * `chat.handlers.ts` (which owns the IPC surface) so other subsystems —
 * `ConversationStore`/`ProjectStore` deleting or archiving a conversation
 * mid-reply — can abort a generation without importing an Electron-coupled
 * IPC module.
 */
const inflight = new Map<string, AbortController>()

/** Register a new generation for `conversationId`, aborting any prior one still in the slot. */
export function registerGeneration(conversationId: string, controller: AbortController): void {
  inflight.get(conversationId)?.abort()
  inflight.set(conversationId, controller)
}

/** Release a generation's slot, but only if it's still the one registered (an overlapping send may have replaced it). */
export function releaseGeneration(conversationId: string, controller: AbortController): void {
  if (inflight.get(conversationId) === controller) inflight.delete(conversationId)
}

/** Abort the in-flight generation for a single conversation, if any — a no-op if none is running. */
export function abortGeneration(conversationId: string): void {
  inflight.get(conversationId)?.abort()
}

/** Abort every in-flight generation — called on app quit. */
export function abortAllGenerations(): void {
  for (const controller of inflight.values()) controller.abort()
  inflight.clear()
}
