import type { ChatMessage } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'
import { conversationStore } from './ConversationStore'

/**
 * Append a completed turn to the conversation a background run writes into —
 * a scheduled task's chat, or an agent run's.
 *
 * These runs hold their `Conversation` object for the whole turn, which is
 * minutes for a scheduled task and can be far longer across an agent run's
 * loop, and `conversationStore.save` replaces the whole document. Writing that
 * snapshot straight back therefore erased anything that landed in between:
 * these chats are ordinary conversations, reachable from the sidebar and from
 * the run's own toast, and the renderer persists a chat by saving all of it
 * (`chatStore.saveConversation`). A message the user typed into the run's chat
 * while it was still working simply disappeared, along with its reply.
 *
 * Re-reading immediately before the write narrows that window to the
 * synchronous merge below. Only the fields a background run genuinely owns are
 * carried over from the caller's copy — the compacted `context` snapshot it
 * just paid for, and the `plan` an agent turn updated — so a rename or any
 * other edit made during the run survives instead of being reverted.
 *
 * Un-archiving is deliberate and predates this: a run that produces a reply
 * puts the chat back in the sidebar so the reply is findable.
 *
 * Returns what was saved, so a caller looping over several turns can carry it
 * forward instead of keeping its own increasingly stale copy.
 */
export function appendBackgroundTurn(
  conversation: Conversation,
  newMessages: ChatMessage[]
): Conversation {
  const current = conversationStore.get(conversation.id) ?? conversation
  const merged: Conversation = {
    ...current,
    messages: [...current.messages, ...newMessages],
    plan: conversation.plan ?? current.plan,
    context: conversation.context ?? current.context,
    archived: false,
    archivedAt: undefined,
    updatedAt: Date.now()
  }
  conversationStore.save(merged)
  return merged
}
