/** Types describing chat messages and the streaming generation protocol. */

import type { ToolCall } from './tools.types'
import type { Plan } from './plan.types'
import type { MemoryEntry } from './memory.types'
import type { TranscriptRecallResult } from './transcriptRecall.types'
import type { ConversationContext, ConversationContextSnapshot } from './context.types'
import type { CheckpointSummary } from './checkpoint.types'

export type ChatRole = 'system' | 'user' | 'assistant'

/** A file the user attached to a message — metadata only; content isn't retained after the turn. */
export interface ChatAttachment {
  /** Absolute path (dropped from the OS) or workspace-relative path (dragged from the Files panel). */
  path: string
  name: string
  sizeBytes: number
}

/** Content read from a dropped/dragged file, for the composer to attach to the next message. */
export interface AttachmentContent {
  content: string
  sizeBytes: number
  truncated: boolean
}

/**
 * One entry in a message's chronological render timeline — either a span of
 * streamed text or a tool call — in the exact order it happened during
 * generation. This is what the UI renders; `content`/`toolCalls` below
 * remain the flat, order-independent forms used for model history replay,
 * project-memory summaries, and export.
 */
export type MessageBlock = { type: 'text'; text: string } | { type: 'tool'; call: ToolCall }

/** A single turn in a conversation, as stored by the renderer. */
export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  createdAt: number
  /** True while assistant tokens are still streaming in. */
  streaming?: boolean
  /** Present if this turn failed to generate. */
  error?: string
  /** Populated once generation completes. */
  stats?: GenerationStats
  /** Tool invocations made by the assistant during this turn. */
  toolCalls?: ToolCall[]
  /**
   * Ordered text/tool timeline for rendering. Absent on messages persisted
   * before this field existed — `messageBlocks()` in the renderer falls back
   * to a reasonable synthesis from `content`/`toolCalls` for those.
   */
  blocks?: MessageBlock[]
  /** Files the user dropped into the composer for this turn, for display only. */
  attachments?: ChatAttachment[]
  /** Memory entries that were retrieved and injected into context for this turn, if any. */
  memoryUsed?: MemoryEntry[]
  /** Past-conversation excerpts that were retrieved and injected into context for this turn, if any. */
  transcriptRecallUsed?: TranscriptRecallResult[]
  /** Restorable snapshot for file changes made by this assistant turn. */
  checkpoint?: CheckpointSummary
}

/** Sampling parameters for a single generation. */
export interface GenerationOptions {
  temperature?: number
  topP?: number
  maxTokens?: number
}

/** A prior conversation turn replayed into a rebuilt chat session. */
export interface ChatHistoryTurn {
  /** Optional persisted message id, used by context snapshots to mark compaction boundaries. */
  id?: string
  role: ChatRole
  content: string
  /** Tool calls made during this (assistant) turn, retained for memory. */
  toolCalls?: ToolCall[]
}

/**
 * A request to generate an assistant reply.
 *
 * `history` contains the prior turns; `prompt` is the new user message. The
 * engine streams tokens back on the `chat:stream` channel keyed by `messageId`,
 * then resolves the invoke with the final `ChatResult`.
 */
export interface ChatRequest {
  conversationId: string
  /** Assistant message id that streamed tokens should be routed to. */
  messageId: string
  /** The project this generation belongs to, or null for a general chat. */
  projectId?: string | null
  systemPrompt?: string
  /** Durable context snapshot for older turns, if this conversation has been compacted before. */
  context?: ConversationContext | null
  history: ChatHistoryTurn[]
  prompt: string
  options?: GenerationOptions
  /** The conversation's current plan, if any, so plan tools can continue it across turns. */
  plan?: Plan | null
}

/** Request to manually compact a conversation into a durable context snapshot. */
export interface ChatCompactRequest {
  conversationId: string
  /** Current durable context snapshot, if any, so compaction can extend it instead of replacing it. */
  context?: ConversationContext | null
  history: ChatHistoryTurn[]
}

/** Result of manual compaction; the renderer supplies the persisted snapshot id. */
export interface ChatCompactResult {
  conversationId: string
  snapshot: Omit<ConversationContextSnapshot, 'id'>
  /** Number of exact turns newly folded into the returned snapshot. */
  compactedTurns: number
}

/** Input for best-effort local chat title generation after the first turn completes. */
export interface ChatTitleRequest {
  userPrompt: string
  assistantReply: string
  attachmentNames?: string[]
  editedFiles?: string[]
}

/** A single streamed token (or token group) for an in-flight assistant reply. */
export interface ChatStreamChunk {
  conversationId: string
  messageId: string
  token: string
}

/** Emitted when older conversation turns were summarized to fit the model's context window. */
export interface HistoryCompactionEvent {
  conversationId: string
  removedTurns: number
  reason: 'onLoad' | 'proactive' | 'reactive'
  /** Whether the removed turns were actually condensed into a summary, vs. just dropped. */
  summarized: boolean
  /** Persistable summary of the removed turns when `summarized` is true. */
  summary?: string
  /** Last original message represented by `summary`, if known. */
  compactedThroughMessageId?: string | null
  createdAt: number
}

/** Throughput metrics reported when a generation finishes. */
export interface GenerationStats {
  tokens: number
  durationMs: number
  tokensPerSecond: number
}

/** The final payload once a generation completes (or is stopped). */
export interface ChatResult {
  conversationId: string
  messageId: string
  content: string
  stats: GenerationStats
  /** True if the generation was stopped by the user before finishing. */
  stopped: boolean
  /** Memory entries that were retrieved and injected into context for this turn, if any. */
  memoryUsed?: MemoryEntry[]
  /** Past-conversation excerpts that were retrieved and injected into context for this turn, if any. */
  transcriptRecallUsed?: TranscriptRecallResult[]
  /** Restorable snapshot for file changes made by this assistant turn. */
  checkpoint?: CheckpointSummary
}
