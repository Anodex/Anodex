import type { Conversation } from '@shared/conversation.types'

export type BranchForEditOutcome =
  | { ok: true; conversation: Conversation }
  | { ok: false; reason: 'not-found' | 'not-a-question' | 'project-chat' }

/**
 * A conversation cut back to just before one of its questions, so that question can
 * be asked again, edited, in its place.
 *
 * The same branch the desktop's own Edit makes (`buildMessageEditBranch`): the
 * question and everything after it go, and a context snapshot that summarised any of
 * that is dropped with them.
 *
 * Refused for a project chat whose later replies would be discarded. Those replies
 * may have changed files, and editing at the computer rolls the files back with the
 * transcript through checkpoints — which a phone is not allowed to do. Cutting only
 * the transcript would leave files changed by replies that no longer exist.
 */
export function branchForEdit(
  conversation: Conversation | null | undefined,
  messageId: string,
  now: number
): BranchForEditOutcome {
  if (!conversation) return { ok: false, reason: 'not-found' }

  const index = conversation.messages.findIndex((message) => message.id === messageId)
  if (index < 0 || conversation.messages[index]?.role !== 'user') {
    return { ok: false, reason: 'not-a-question' }
  }

  const discarded = conversation.messages.slice(index + 1)
  if (conversation.projectId && discarded.some((message) => message.role === 'assistant')) {
    return { ok: false, reason: 'project-chat' }
  }

  const snapshot = conversation.context?.activeSnapshot
  const through = snapshot?.throughMessageId
  const throughIndex = through
    ? conversation.messages.findIndex((message) => message.id === through)
    : -1
  const clearContext =
    Boolean(snapshot) && (through === null || throughIndex < 0 || index <= throughIndex)

  return {
    ok: true,
    conversation: {
      ...conversation,
      messages: conversation.messages.slice(0, index),
      ...(clearContext ? { context: null } : {}),
      updatedAt: now
    }
  }
}
