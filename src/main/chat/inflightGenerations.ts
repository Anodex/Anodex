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

/**
 * Whether any generation is currently running.
 *
 * Asked before switching the active project. There is one active project and it is
 * global state — `ProjectStore.setActive` writes `settings.workspace.root` — so
 * switching mid-generation pulls the workspace out from under a live turn. That is
 * breakage rather than a surprise, and it matters most for a switch initiated from
 * a phone, where nobody is watching the machine it happens on (§10.1).
 */
export function hasInflightGeneration(): boolean {
  return inflight.size > 0
}

/**
 * Why the active project cannot change to `requested` right now, or `null`.
 *
 * A "switch" to the project already active changes nothing, so it is never
 * refused. The sidebar asks for one on every chat it opens, and the person who
 * opened another chat while a reply ran was told "Could not switch project"
 * when no project was involved at all: no project to no project.
 */
export function projectSwitchRefusal(
  current: string | null,
  requested: string | null
): string | null {
  if (current === requested || !hasInflightGeneration()) return null
  return 'Anodex is working on something right now. Wait for it to finish before switching project.'
}

/** Abort every in-flight generation — called on app quit. */
export function abortAllGenerations(): void {
  for (const controller of inflight.values()) controller.abort()
  inflight.clear()
}
