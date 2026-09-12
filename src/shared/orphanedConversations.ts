/**
 * Which conversations point at a project this machine no longer has.
 *
 * Pure, and separated from the launch reconciler, because it is the part with a
 * decision in it and that decision is destructive: an orphan has its `projectId`
 * nulled *and persisted*, which cannot be undone by putting the project back.
 *
 * ## Archived is not gone
 *
 * This shipped comparing against the *active* project list, which
 * `projects:list` filters archived projects out of. So archiving a project made
 * every conversation in it look orphaned, and the next launch quietly moved a
 * project's entire history into general Chats — permanently, since the link was
 * removed from disk rather than hidden.
 *
 * It is also how a chat that had edited files ended up under Chats, which is
 * supposed to mean "no project, therefore no writing" (see `buildTools`). The
 * placement and the permission are the same fact, so corrupting one silently
 * contradicts the other.
 *
 * @param knownProjectIds every project the machine has, **archived included**.
 *   Passing only the active ones is the bug this module exists to prevent.
 */
export function orphanedConversationIds(
  conversations: readonly { id: string; projectId: string | null }[],
  knownProjectIds: ReadonlySet<string>
): string[] {
  return conversations
    .filter((c) => c.projectId !== null && !knownProjectIds.has(c.projectId))
    .map((c) => c.id)
}
