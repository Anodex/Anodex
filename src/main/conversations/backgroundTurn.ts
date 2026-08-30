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
/**
 * Whether this message would show the reader nothing and record nothing.
 *
 * Measured: four agent runs end with an empty assistant message carrying
 * `{tokens: 0, durationMs: 1}` — a duration that says no generation happened at
 * all — which renders as an empty bubble in the transcript.
 *
 * Deliberately not "the content is empty". Blanks in the store were found
 * holding real data: one carried 6,579 characters of reasoning alongside an
 * `error` and `errorKind`, and several others carried an error with no visible
 * reply. Dropping on emptiness alone would have destroyed exactly the records
 * someone would go looking for after a failure.
 *
 * So a message is discarded only when every channel it could speak through is
 * empty: no visible text, no tool calls, no reasoning, no error. A turn that
 * genuinely produced nothing is already accounted for in the run's own record —
 * `turnsUsed` counts it and the stop reason explains it — so the transcript
 * gains nothing from an empty bubble.
 */
export function carriesNothing(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false
  return (
    String(message.content ?? '').trim().length === 0 &&
    (message.toolCalls?.length ?? 0) === 0 &&
    !message.thinking &&
    !message.error
  )
}

export function appendBackgroundTurn(
  conversation: Conversation,
  newMessages: ChatMessage[]
): Conversation {
  const current = conversationStore.get(conversation.id) ?? conversation
  const merged: Conversation = {
    ...current,
    messages: [...current.messages, ...newMessages.filter((message) => !carriesNothing(message))],
    plan: conversation.plan ?? current.plan,
    context: conversation.context ?? current.context,
    archived: false,
    archivedAt: undefined,
    updatedAt: Date.now()
  }
  conversationStore.save(merged)
  return merged
}
