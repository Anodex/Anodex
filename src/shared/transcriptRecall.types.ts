/**
 * Automatic cross-session transcript recall: excerpts from past conversations
 * surfaced into the current turn's context when they're lexically relevant to
 * what the user just asked — the "what did we decide about X last week"
 * case, without a model-facing search tool (see `transcriptSearch.ts`).
 * Always rendered as reference data (see `prompts.ts`'s
 * `PAST_CHATS_REFERENCE_NOTE`) — never as instructions.
 */

export interface TranscriptRecallExcerpt {
  messageId: string
  role: 'user' | 'assistant'
  /** Bounded preview, not the full message text. */
  text: string
  score: number
}

export interface TranscriptRecallResult {
  conversationId: string
  projectId: string | null
  title: string
  updatedAt: number
  excerpts: TranscriptRecallExcerpt[]
}
