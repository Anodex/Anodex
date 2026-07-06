import type { ChatMessage } from './chat.types'
import type { Plan } from './plan.types'

/** A persisted conversation, either inside a project or general (projectId null). */
export interface Conversation {
  id: string
  /** The project this chat belongs to, or null for general chats. */
  projectId: string | null
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  /** The assistant's current self-tracked task plan for this conversation, if any. */
  plan?: Plan | null
}

/** Persisted UI state for the conversation list. */
export interface ConversationState {
  activeConversationId: string | null
}
