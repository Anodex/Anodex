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

export interface VerificationResult {
  command: string
  status: 'passed' | 'failed'
}

/**
 * A structured record of one completed coding turn, built from what actually
 * happened — real tool outcomes — rather than the assistant's own prose claim
 * about what it did. Replaces the earlier `TaskSummary` (a 220-char excerpt
 * of the assistant's final reply), which had no way to distinguish a genuine
 * fix from a plausible-sounding but fabricated one; see this project's
 * documented history of models claiming success without a real tool call
 * behind it.
 */
export interface ProjectRecallEvent {
  conversationId: string
  messageId: string
  createdAt: number
  /** Workspace-relative paths written/edited/deleted/moved by a successful tool call this turn. */
  changedFiles: string[]
  /** Names of tools that completed successfully this turn (may repeat). */
  successfulTools: string[]
  /** Names of tools that errored this turn (may repeat). */
  failedTools: string[]
  /** Commands run via `run_command`, with their real exit status. */
  verification: VerificationResult[]
  /**
   * The assistant's own final reply text for this turn, kept as supplemental
   * context only — explicitly non-authoritative. `changedFiles`/`verification`
   * above are the verified record of what happened; this is just what the
   * model said about it, which is not the same thing.
   */
  assistantSummary?: string
}

export interface ProjectMemory {
  projectId: string
  /** Most recent touch per path, newest first, capped. */
  filesTouched: FileTouch[]
  /** Most recent completed coding turns, newest first, capped. */
  recentEvents: ProjectRecallEvent[]
}
