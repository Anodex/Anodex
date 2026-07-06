/**
 * Lightweight, per-project memory of what the assistant has already touched.
 *
 * Unlike conversation history (scoped to one chat), this persists across
 * conversations for the same project, so switching chats — or restarting the
 * app — doesn't make the assistant forget which files it recently inspected
 * or changed. It is intentionally small: a capped activity ledger fed into
 * the system prompt, not a full index or vector store.
 */

export type FileTouchAction = 'read' | 'write' | 'delete' | 'move'

export interface FileTouch {
  /** Path relative to the project's workspace root. */
  path: string
  action: FileTouchAction
  at: number
}

export interface TaskSummary {
  conversationId: string
  /** Short excerpt of the assistant's final reply for that turn. */
  summary: string
  at: number
}

export interface ProjectMemory {
  projectId: string
  /** Most recent touch per path, newest first, capped. */
  filesTouched: FileTouch[]
  /** Most recent completed coding turns, newest first, capped. */
  recentSummaries: TaskSummary[]
}
