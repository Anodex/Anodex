import type { ChatMessage } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'

export interface MessageEditBranch {
  target: ChatMessage
  retainedMessages: ChatMessage[]
  discardedAssistantMessageIds: string[]
  clearContext: boolean
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
