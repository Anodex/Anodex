/** Types describing chat messages and the streaming generation protocol. */

import type { ToolCall } from './tools.types'
import type { Plan } from './plan.types'
import type { MemoryEntry } from './memory.types'
import type { TranscriptRecallResult } from './transcriptRecall.types'
import type { ConversationContext, ConversationContextSnapshot } from './context.types'
import type { CheckpointSummary } from './checkpoint.types'

export type ChatRole = 'system' | 'user' | 'assistant'

export type GenerationStopReason =
  | 'user'
  | 'loop-guard'
  | 'context-limit'
  | 'context-shift-limit'
  | 'fixed-context-limit'
  | 'rounds-exhausted'
  | 'time-limit'
  | 'tool-limit'
  | 'token-limit'
  | 'no-progress'
  | 'yielded'

/** Exact local-model input accounting captured with the active wrapper and tokenizer. */
export interface ContextBudgetUsage {
  contextSize: number
  /** Maximum rendered input accepted while preserving node-llama-cpp's context-shift room. */
  inputLimitTokens: number
  /** System prompt plus wrapper framing, measured without the current user prompt or tools. */
  systemTokens: number
  /** Incremental rendered cost of the current user prompt. */
  promptTokens: number
  /** Incremental rendered cost of the active function definitions and parameter schemas. */
  toolSchemaTokens: number
  /** Exact rendered system + current prompt + active tool cost before generation. */
  fixedTokens: number
  /** Context reserved by node-llama-cpp for continued generation during a shift. */
  reservedTokens: number
  /** User-configured reply ceiling before local context safety is applied. */
  requestedMaxOutputTokens?: number
  /** Actual local reply ceiling after accounting for measured fixed input. */
  effectiveMaxOutputTokens?: number
  activeToolCount: number
  /** Full schemas omitted from the prompt but still callable through the on-demand gateway. */
  deferredToolCount: number
  toolRoutingApplied: boolean
}

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
export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; call: ToolCall }
  | { type: 'thinking'; text: string }

/** A single turn in a conversation, as stored by the renderer. */
export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  createdAt: number
  /** True while assistant tokens are still streaming in. */
  streaming?: boolean
  /** Present if this turn failed to generate, or reached a bounded stop worth explaining. */
  error?: string
  /**
   * Distinguishes a genuine failure from a bounded, recoverable stop that
   * still preserved real content (a token/round/time/tool-call budget, or a
   * context-compaction limit) — `undefined`/`'failure'` renders as the red
   * error it always has; `'bounded'` renders as a calmer, non-alarming note
   * so a safety yield with useful output above it doesn't read as broken.
   * Absent on messages persisted before this field existed, which always
   * meant a real failure — the default preserves that behavior exactly.
   */
  errorKind?: 'failure' | 'bounded'
  /** Populated once generation completes. */
  stats?: GenerationStats
  /** Exact fixed-context/tool accounting reported by the local engine for this turn. */
  contextBudget?: ContextBudgetUsage
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
  /**
   * Real chain-of-thought text the model produced separately from its visible
   * reply, if any — only reasoning-tuned local models emit this (see
   * `GenerateOutcome.thinking` in `LlamaService.ts`). Shown collapsed in the
   * UI; absent (not an empty string) on a normal model's reply.
   */
  thinking?: string
}

/** Sampling parameters for a single generation. */
export interface GenerationOptions {
  temperature?: number
  topP?: number
  maxTokens?: number
  /**
   * Optional sub-budget, in tokens, that hidden reasoning may spend out of
   * `maxTokens` before the provider closes that segment and continues into
   * the visible/function-call portion of the same hard cap — not an
   * additional allowance on top of it. Only the local provider currently
   * supports this (see `LlamaService.ts`); omit it to use the provider's own
   * default reasoning allowance. Set it when a phase needs a *guaranteed*
   * minimum visible-output reserve (e.g. Critical Thinking synthesis/repair —
   * see `criticalThinkingSynthesisLimits().thoughtTokens` in
   * `criticalThinkingSynthesisBudget.ts`)
   * rather than leaving reasoning free to consume the whole cap.
   */
  thoughtTokens?: number
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

/** Live chain-of-thought tokens, streamed separately from `ChatStreamChunk`'s visible-reply tokens. */
export interface ChatThinkingStreamChunk {
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
  /**
   * True if the turn ended before naturally finishing — a real user Stop,
   * or an internal reason (see `stopReason`). NOT always a user action.
   */
  stopped: boolean
  /**
   * Why `stopped` is true, when known. `'context-limit'` means the turn hit
   * the model's hard context ceiling; `'context-shift-limit'` means Anodex
   * stopped after its bounded number of compaction attempts. The renderer
   * shows an explanatory notice for these cases specifically (see
   * `chatStore.ts`'s `sendMessage`), since otherwise it renders as an empty
   * or truncated reply with no indication why. Undefined for a plain user
   * Stop or a provider that doesn't distinguish reasons. See
   * `GenerateOutcome.stopReason`'s doc comment in `LlamaService.ts` for the
   * full list and what produces each one. A plain user Stop is reported as
   * `'user'` when the provider exposes that distinction.
   */
  stopReason?: GenerationStopReason
  /** Exact fixed-context/tool accounting reported by the local engine for this turn. */
  contextBudget?: ContextBudgetUsage
  /** Memory entries that were retrieved and injected into context for this turn, if any. */
  memoryUsed?: MemoryEntry[]
  /** Past-conversation excerpts that were retrieved and injected into context for this turn, if any. */
  transcriptRecallUsed?: TranscriptRecallResult[]
  /** Restorable snapshot for file changes made by this assistant turn. */
  checkpoint?: CheckpointSummary
  /** See `ChatMessage.thinking`'s doc comment. */
  thinking?: string
}
