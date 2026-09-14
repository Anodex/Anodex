import { useEffect } from 'react'
import type { Conversation } from '@shared/conversation.types'
import { useChatStore } from '../stores/chatStore'

/**
 * A conversation from the store, with its messages read if they have not been yet.
 *
 * For a view that shows a conversation other than the open chat — an agent run's
 * log, a scheduled task's. The window lists conversations without their messages;
 * until the read lands this returns the listed copy, whose `messagesNotLoaded` says
 * its empty `messages` means nothing yet.
 */
export function useLoadedConversation(id: string | null | undefined): Conversation | undefined {
  const conversation = useChatStore((s) =>
    id ? s.conversations.find((candidate) => candidate.id === id) : undefined
  )
  const ensureConversationLoaded = useChatStore((s) => s.ensureConversationLoaded)
  const waiting = conversation?.messagesNotLoaded === true

  useEffect(() => {
    if (id && waiting) void ensureConversationLoaded(id)
  }, [id, waiting, ensureConversationLoaded])

  return conversation
}
