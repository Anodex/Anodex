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
  /**
   * The focused outcome the user set with `/goal`. It stays with the chat so
   * the composer can keep the task visible while work and its plan progress.
   */
  goal?: ConversationGoal
  /** Durable model-context snapshot for older turns; the UI transcript stays complete. */
  context?: ConversationContext | null
  /**
   * A best-effort follow-up shown as composer ghost text after a completed reply.
   * It is conversation UI state only: never appended to messages or sent back to
   * a model unless the user explicitly accepts and sends it.
   */
  replaySuggestion?: ConversationReplaySuggestion
  /** Set when every turn in this chat came from an automated scheduled task or agent run, not the user. */
  origin?: 'scheduled' | 'agent'
  /**
   * The email conversation this chat was opened for, when it started from the
   * Email page's Reply or Summarize action.
   *
   * Reopening the same thread returns to this chat instead of starting another
   * one, so the discussion about a given email stays in a single place. Once
   * the chat is archived or deleted it leaves the active list and a fresh chat
   * is created on the next handoff.
   */
  emailThread?: EmailThreadLink
}

export interface ConversationReplaySuggestion {
  /** The completed assistant reply this suggestion was generated from. */
  messageId: string
  text: string
  createdAt: number
}

export interface ConversationGoal {
  title: string
  createdAt: number
}

/**
 * Which email conversation a chat is about, and enough of it for the model to
 * act without searching the mailbox again.
 *
 * `subject` and `latestMessageId` are refreshed every time the thread is
 * opened, because a thread grows: the reply the user asks for should answer
 * the newest message, not whichever one was newest when the chat started.
 * They're optional so chats linked by an older build still load.
 */
export interface EmailThreadLink {
  accountId: string
  threadId: string
  subject?: string
  /** Id of the newest message in the thread, which `reply_email` addresses. */
  latestMessageId?: string
}

/** Persisted UI state for the conversation list. */
export interface ConversationState {
  activeConversationId: string | null
}
