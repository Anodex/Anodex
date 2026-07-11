import type { ChatMessage } from './chat.types'
import type { ConversationContext } from './context.types'
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
  /** Archived chats are hidden from the sidebar until restored from Settings. */
  archived?: boolean
  archivedAt?: number
  /** The assistant's current self-tracked task plan for this conversation, if any. */
  plan?: Plan | null
  /** Durable model-context snapshot for older turns; the UI transcript stays complete. */
  context?: ConversationContext | null
  /** Set when every turn in this chat came from an automated scheduled task or agent run, not the user. */
  origin?: 'scheduled' | 'agent'
}

/** Persisted UI state for the conversation list. */
export interface ConversationState {
  activeConversationId: string | null
}
