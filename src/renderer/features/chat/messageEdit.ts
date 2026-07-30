import type { ChatMessage } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'

export interface MessageEditBranch {
  target: ChatMessage
  retainedMessages: ChatMessage[]
  discardedAssistantMessageIds: string[]
  clearContext: boolean
}

export interface RegenerateTarget {
  /** The user turn that prompted the reply — regenerating replays exactly this. */
  sourceUserMessageId: string
  /**
   * Turns after the one being regenerated, which regenerating discards. Zero
   * for the newest reply, the only case that needs no warning.
   */
  laterTurnCount: number
}

/**
 * Resolve what regenerating an assistant reply would replay and what it would
 * throw away.
 *
 * Regenerating is re-sending the user turn that prompted the reply, so it
 * reduces to the same branch an edit produces — the difference is only that
 * the text is unchanged. Returns `null` when there is nothing to replay: a
 * user turn, or an assistant turn with no user turn before it, which is what
 * a scheduled-task or agent-run transcript opens with.
 *
 * Takes the message array rather than the conversation so the transcript can
 * ask the same question the store will — whether to offer the action at all,
 * and how many turns it discards — without a second rule that could drift
 * from this one.
 */
export function buildRegenerateTarget(
  messages: ChatMessage[],
  messageId: string
): RegenerateTarget | null {
  const targetIndex = messages.findIndex((message) => message.id === messageId)
  if (targetIndex < 0 || messages[targetIndex].role !== 'assistant') return null

  for (let index = targetIndex - 1; index >= 0; index--) {
    if (messages[index].role === 'user') {
      return {
        sourceUserMessageId: messages[index].id,
        laterTurnCount: messages.length - 1 - targetIndex
      }
    }
  }
  return null
}

export function buildMessageEditBranch(
  conversation: Conversation,
  messageId: string
): MessageEditBranch | null {
  const targetIndex = conversation.messages.findIndex((message) => message.id === messageId)
  const target = conversation.messages[targetIndex]
  if (targetIndex < 0 || target?.role !== 'user') return null

  const snapshot = conversation.context?.activeSnapshot
  const throughMessageId = snapshot?.throughMessageId
  const throughIndex = throughMessageId
    ? conversation.messages.findIndex((message) => message.id === throughMessageId)
    : -1

  return {
    target,
    retainedMessages: conversation.messages.slice(0, targetIndex),
    discardedAssistantMessageIds: conversation.messages
      .slice(targetIndex + 1)
      .filter((message) => message.role === 'assistant')
      .map((message) => message.id),
    clearContext:
      Boolean(snapshot) &&
      (throughMessageId === null || throughIndex < 0 || targetIndex <= throughIndex)
  }
}
