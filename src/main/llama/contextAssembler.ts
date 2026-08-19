import { createHash } from 'node:crypto'
import type { ChatHistoryTurn } from '@shared/chat.types'
import { currentLedgerRevision, type ConversationContext } from '@shared/context.types'
import type { ToolCall } from '@shared/tools.types'
import { sanitizeHistoryTurn } from '@shared/chatSanitizer'
import { MAX_MODEL_TOOL_RESULT_CHARS } from '@shared/contextBudget'
import { APPROX_CHARS_PER_TOKEN } from '@shared/contextProjection'
import {
  buildCompactionSystemPrompt,
  CLOUD_SUMMARY_CHUNK_TOKEN_BUDGET,
  MIN_CHARS_TO_SUMMARIZE,
  renderTurnsForSummary,
  reservedNonHistoryTokens,
  splitHistoryByTokenBudget,
  turnTokenCost
} from './compaction'
import {
  foldIntoRollingSummary,
  ROLLING_SUMMARY_TOKEN_CEILING,
  type RollingSummarizer
} from './rollingSummary'

/**
 * Maximum remembered output per past tool call when rebuilding model context.
 *
 * The chat UI may retain richer tool details for display, but replaying large
 * reads, command logs, or generated file contents verbatim makes old tool
 * output crowd out the user's latest request. Keep the model-facing record
 * concise and self-describing; the model can ask to read the file/rerun the
 * command when it truly needs the omitted detail.
 */
export { MAX_MODEL_TOOL_RESULT_CHARS } from '@shared/contextBudget'

const TOOL_RESULT_TRUNCATION_NOTICE =
  '\n\n[Anodex truncated this older tool result for context. Re-read or rerun it if exact detail is needed.]'
const MAX_MODEL_TOOL_TITLE_CHARS = 360
const TOOL_TITLE_TRUNCATION_NOTICE = '… [Anodex omitted the rest of this tool label for context.]'

export interface ModelContextReport {
  /** Full sanitized turns before budget splitting. */
  originalTurns: number
  /** Turns retained verbatim in the projected model context. */
  recentTurns: number
  /** Turns omitted from verbatim replay because the projected context was full. */
  removedTurns: number
  /** Whether older omitted turns were represented by a summary in the system prompt. */
  summarized: boolean
  /** Token budget available to chat history after system/reserved tokens. */
  historyBudgetTokens: number
  /** Approximate tokens consumed by the retained projected turns. */
  historyTokens: number
  /** Approximate tokens consumed by the final system prompt, including summary if present. */
  systemTokens: number
}

export interface ModelContextAssembly {
  systemPrompt: string | undefined
  history: ChatHistoryTurn[]
  removedTurns: number
  summarized: boolean
  /** Complete replacement summary after folding the prior snapshot and new overflow. */
  summary?: string
  /** Last original message represented by `summary`, if known. */
  compactedThroughMessageId?: string | null
  /** True when a legacy oversized snapshot was rebased before replay. */
  summaryRebased: boolean
  report: ModelContextReport
}

export interface SnapshotSeededContext {
  systemPrompt: string | undefined
  history: ChatHistoryTurn[]
  applied: boolean
  summary?: string
  throughMessageId?: string | null
  /** A fingerprinted derived snapshot no longer matched canonical history. */
  stale?: boolean
}

/**
 * Stable fingerprint for the exact persisted prefix a ledger revision claims
 * to summarize. This lives in the main-process assembler because Node crypto
 * hashes large tool-heavy histories without expanding them into another string.
 */
export function historyPrefixFingerprint(
  history: ChatHistoryTurn[],
  throughMessageId: string | null | undefined
): string | undefined {
  if (!throughMessageId) return undefined
  const boundaryIndex = history.findIndex((turn) => turn.id === throughMessageId)
  if (boundaryIndex < 0) return undefined

  const hash = createHash('sha256')
  for (const turn of history.slice(0, boundaryIndex + 1)) {
    hashPart(hash, turn.id)
    hashPart(hash, turn.role)
    hashPart(hash, turn.content)
    for (const attachment of turn.attachments ?? []) {
      hashPart(hash, attachment.path)
      hashPart(hash, attachment.name)
      hashPart(hash, attachment.mimeType)
      hashPart(hash, attachment.visionContextPinned)
    }
    for (const call of turn.toolCalls ?? []) {
      hashPart(hash, call.id)
      hashPart(hash, call.name)
      hashPart(hash, call.kind)
      hashPart(hash, call.status)
      hashPart(hash, call.title)
      hashPart(hash, call.result)
      hashPart(hash, call.detail)
      hashPart(hash, call.touchedPaths?.join('\u0000'))
    }
  }
  return hash.digest('hex')
}

function hashPart(hash: ReturnType<typeof createHash>, value: unknown): void {
  const text =
    value === undefined || value === null
      ? ''
      : typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? value.toString()
          : (JSON.stringify(value) ?? '')
  hash.update(String(text.length))
  hash.update('\u0000')
  hash.update(text)
  hash.update('\u0000')
}

export interface ModelContextAssemblyInput {
  systemPrompt: string | undefined
  history: ChatHistoryTurn[]
  contextSize: number
  countTokens: (text: string) => number
  /**
   * Replacement-style rolling summarizer (see `RollingSummarizer` in
   * `rollingSummary.ts`): receives one bounded transcript chunk plus the
   * previous rolling summary and returns the complete updated summary.
   * Overflowing turns are fed to it chunk-by-chunk via
   * `foldIntoRollingSummary`, never as one unbounded transcript — the
   * summarizer's own context is small (4,096 tokens for the local engine).
   */
  summarizeOlderTurns: RollingSummarizer
  /** Fixed tool-schema cost reserved in addition to system/reply room (local provider). */
  toolSchemaReserveTokens?: number
  /**
   * Per-chunk transcript budget for the fold — defaults to the local
   * engine's `SUMMARY_CHUNK_TOKEN_BUDGET`. Cloud callers pass
   * `CLOUD_SUMMARY_CHUNK_TOKEN_BUDGET` so one big overflow doesn't become a
   * long series of small paid API calls (see that constant's doc comment).
   */
  summaryChunkTokenBudget?: number
  /**
   * Per-message framing the caller's transport pays and this assembly's
   * character-based estimate cannot see. See `turnTokenCost` in
   * `compaction.ts`; 0 (the default) preserves the prior behaviour.
   */
  messageFramingTokens?: number
  /**
   * Fraction of the history budget the Context Ledger may keep verbatim; the
   * rest is summarized or dropped. The bounded recall window starts a rebuilt
   * session below the compaction trigger so it has room to refill.
   */
  recallWindowFraction?: number | null
  /**
   * Existing durable summary for history removed before this assembly. New
   * overflow is folded into it as one replacement summary, never appended.
   */
  initialSummary?: string
}

/**
 * Build the projected conversation sent to the model.
 *
 * This is intentionally separate from the persisted chat transcript: Anodex
 * keeps the full conversation for the user and auditability, while the model
 * receives a bounded, sanitized projection optimized for the next turn.
 */
export async function assembleModelContext({
  systemPrompt,
  history,
  contextSize,
  countTokens,
  summarizeOlderTurns,
  toolSchemaReserveTokens = 0,
  summaryChunkTokenBudget,
  messageFramingTokens = 0,
  recallWindowFraction,
  initialSummary
}: ModelContextAssemblyInput): Promise<ModelContextAssembly> {
  const projectedHistory = projectHistoryForModel(history)
  const normalizedInitialSummary = await rebaseOversizedSummary(
    initialSummary,
    countTokens,
    summarizeOlderTurns,
    summaryChunkTokenBudget
  )
  const initialSystemPrompt = normalizedInitialSummary
    ? buildCompactionSystemPrompt(systemPrompt, normalizedInitialSummary)
    : systemPrompt
  const initialBudget = historyBudgetTokens(
    initialSystemPrompt,
    contextSize,
    countTokens,
    toolSchemaReserveTokens,
    recallWindowFraction
  )
  const split = splitHistoryByTokenBudget(
    projectedHistory,
    initialBudget,
    countTokens,
    messageFramingTokens
  )

  let older = split.older
  let projectedRecent = split.recent
  let summary = normalizedInitialSummary
  if (older.length > 0) {
    const folded = await summarizeTurns(older, summarizeOlderTurns, countTokens, {
      previousSummary: summary,
      chunkTokenBudget: summaryChunkTokenBudget
    })
    if (folded) summary = folded
  }
  let projectedSystemPrompt = summary
    ? buildCompactionSystemPrompt(systemPrompt, summary)
    : initialSystemPrompt

  if (summary) {
    // If the summary itself pushes some "recent" turns out of budget, fold
    // those turns into the rolling summary so the projected context has no
    // unsummarized gap between the summary and verbatim replay. Only the
    // NEWLY overflowing turns are folded (with the existing summary as the
    // rolling base) — re-summarizing the whole accumulated `older` slice
    // from scratch each pass, as this used to, redoes work and can feed the
    // summarizer an ever-larger transcript. A pass whose new slice is too
    // small to summarize (`null`) keeps the summary it already has and
    // drops just those few turns, instead of the old all-or-nothing
    // drop-everything fallback.
    // Each pass removes at least one turn from `projectedRecent`, so this
    // converges in at most the number of retained turns. A fixed pass count
    // is not sufficient: a replacement summary can grow again on pass 2 and
    // push yet another turn over the newly reduced budget.
    while (projectedRecent.length > 0) {
      const budget = historyBudgetTokens(
        projectedSystemPrompt,
        contextSize,
        countTokens,
        toolSchemaReserveTokens,
        recallWindowFraction
      )
      const finalSplit = splitHistoryByTokenBudget(
        projectedRecent,
        budget,
        countTokens,
        messageFramingTokens
      )
      projectedRecent = finalSplit.recent
      if (finalSplit.older.length === 0) break

      older = [...older, ...finalSplit.older]
      const expandedSummary = await summarizeTurns(
        finalSplit.older,
        summarizeOlderTurns,
        countTokens,
        {
          previousSummary: summary,
          chunkTokenBudget: summaryChunkTokenBudget
        }
      )
      if (expandedSummary) {
        summary = expandedSummary
        projectedSystemPrompt = buildCompactionSystemPrompt(systemPrompt, summary)
      }
    }
  }

  const finalBudget = historyBudgetTokens(
    projectedSystemPrompt,
    contextSize,
    countTokens,
    toolSchemaReserveTokens,
    recallWindowFraction
  )
  const removedTurns = older.length

  return {
    systemPrompt: projectedSystemPrompt,
    history: projectedRecent,
    removedTurns,
    summarized: summary !== undefined,
    summary: summary ?? undefined,
    compactedThroughMessageId: summary ? lastTurnId(older) : undefined,
    summaryRebased: normalizedInitialSummary !== initialSummary,
    report: {
      originalTurns: projectedHistory.length,
      recentTurns: projectedRecent.length,
      removedTurns,
      summarized: summary !== undefined,
      historyBudgetTokens: finalBudget,
      historyTokens: historyTokens(projectedRecent, countTokens, messageFramingTokens),
      systemTokens: countTokens(projectedSystemPrompt ?? '')
    }
  }
}

/**
 * Apply a persisted context snapshot before doing any new budget splitting.
 *
 * This mirrors OpenCode's context-epoch idea: old turns remain in the saved
 * conversation, but the active model context begins from the durable summary
 * plus exact turns after the snapshot boundary.
 */
export function seedContextFromSnapshot(
  systemPrompt: string | undefined,
  history: ChatHistoryTurn[],
  context: ConversationContext | null | undefined
): SnapshotSeededContext {
  const revision = currentLedgerRevision(context)
  if (!revision?.continuityDigest || !revision.throughMessageId) {
    return { systemPrompt, history: projectHistoryForModel(history), applied: false }
  }

  const projectedHistory = projectHistoryForModel(history)
  const boundaryIndex = projectedHistory.findIndex((turn) => turn.id === revision.throughMessageId)
  if (boundaryIndex < 0) {
    return { systemPrompt, history: projectedHistory, applied: false }
  }
  if (
    revision.sourcePrefixFingerprint &&
    historyPrefixFingerprint(history, revision.throughMessageId) !==
      revision.sourcePrefixFingerprint
  ) {
    return { systemPrompt, history: projectedHistory, applied: false, stale: true }
  }

  return {
    systemPrompt: buildCompactionSystemPrompt(systemPrompt, revision.continuityDigest),
    history: projectedHistory.slice(boundaryIndex + 1),
    applied: true,
    summary: revision.continuityDigest,
    throughMessageId: revision.throughMessageId
  }
}

export interface CloudBoundedContext {
  systemPrompt: string | undefined
  history: ChatHistoryTurn[]
  /** Older turns removed from this turn's context, summarized or dropped. */
  omittedTurns: number
  /** Whether `omittedTurns` were actually condensed into a summary, vs. just dropped. */
  summarized: boolean
  /** Complete replacement summary after folding the prior snapshot and new overflow. */
  summary?: string
  /** Last original message represented by `summary`, if known. */
  compactedThroughMessageId?: string | null
  /** Total original turns covered by the returned summary. */
  coveredTurns?: number
  /** True when a legacy oversized snapshot was rebased before replay. */
  summaryRebased?: boolean
  /** True when a fingerprinted prior summary no longer matched raw history. */
  snapshotStale?: boolean
}

/**
 * Bound history for a **stateless** provider — one that re-sends the whole
 * conversation on every request and so has no session of its own to compact
 * inside. That covers the cloud providers (OpenAI/Anthropic/Azure, whose
 * tokens Anodex estimates from character count) and, despite the "cloud"
 * heritage of this code, Anodex's own llama-server transport in
 * `LlamaVisionService`, which is stateless in exactly the same way.
 *
 * Always applies the same persisted-snapshot seeding the local engine uses.
 * With no `summarizeOlderTurns` supplied, turns that don't fit are dropped,
 * never summarized (used before a summarizer existed, and still the fallback
 * if a caller doesn't have one). With one supplied, delegates to the same
 * `assembleModelContext` pipeline the local engine uses, so these
 * conversations get the identical summarize-and-fold-back behavior — just
 * with a different model doing the summarizing.
 *
 * `summaryChunkTokenBudget` sizes each transcript chunk handed to the
 * summarizer, and must match the context that summarizer actually runs in:
 * a cloud model gets `CLOUD_SUMMARY_CHUNK_TOKEN_BUDGET`, while a local one
 * gets a budget derived from its real context (see
 * `summaryChunkBudgetForContext`) — feeding cloud-sized chunks to a small
 * local context would overflow the very call meant to relieve the overflow.
 *
 * `options.toolSchemaReserveTokens` is not optional in spirit, only in
 * signature. Tool schemas are fixed prompt overhead that no amount of history
 * compaction can shrink, and a caller that omits them plans against a budget
 * short by their entire cost — the shortfall then lands on the reply, since
 * history is bounded before the transport ever measures the real prompt. The
 * node-llama-cpp path has always reserved for this (`LlamaService.generate`);
 * every stateless transport pays the same overhead and needs the same reserve.
 */
export async function boundHistoryForStatelessProvider(
  systemPrompt: string | undefined,
  history: ChatHistoryTurn[],
  context: ConversationContext | null | undefined,
  contextWindowTokens: number,
  summarizeOlderTurns?: RollingSummarizer,
  summaryChunkTokenBudget: number = CLOUD_SUMMARY_CHUNK_TOKEN_BUDGET,
  options?: {
    toolSchemaReserveTokens?: number
    messageFramingTokens?: number
    /** Keep the stateless transport's replay window aligned with the local engine. */
    recallWindowFraction?: number | null
  }
): Promise<CloudBoundedContext> {
  const seeded = seedContextFromSnapshot(systemPrompt, history, context)
  const toolSchemaReserveTokens = options?.toolSchemaReserveTokens ?? 0
  const messageFramingTokens = options?.messageFramingTokens ?? 0

  if (!summarizeOlderTurns) {
    const budget = historyBudgetTokens(
      seeded.systemPrompt,
      contextWindowTokens,
      estimateTokensApprox,
      toolSchemaReserveTokens,
      options?.recallWindowFraction
    )
    const split = splitHistoryByTokenBudget(
      seeded.history,
      budget,
      estimateTokensApprox,
      messageFramingTokens
    )
    return {
      systemPrompt: seeded.systemPrompt,
      history: split.recent,
      omittedTurns: split.older.length,
      summarized: false,
      snapshotStale: seeded.stale
    }
  }

  const assembled = await assembleModelContext({
    // `seeded.systemPrompt` already contains the old digest. Pass the base
    // prompt and digest separately so new overflow is folded into that digest
    // as a replacement, instead of creating two summaries to concatenate.
    systemPrompt,
    history: seeded.history,
    contextSize: contextWindowTokens,
    countTokens: estimateTokensApprox,
    summarizeOlderTurns,
    summaryChunkTokenBudget,
    toolSchemaReserveTokens,
    messageFramingTokens,
    recallWindowFraction: options?.recallWindowFraction,
    initialSummary: seeded.summary
  })
  const priorCoveredTurns = seeded.applied ? (currentLedgerRevision(context)?.coveredTurns ?? 0) : 0

  return {
    systemPrompt: assembled.systemPrompt,
    history: assembled.history,
    omittedTurns: assembled.removedTurns,
    summarized: assembled.summarized,
    summary: assembled.summary,
    compactedThroughMessageId:
      assembled.compactedThroughMessageId ?? seeded.throughMessageId ?? null,
    coveredTurns: priorCoveredTurns + assembled.removedTurns,
    summaryRebased: assembled.summaryRebased,
    snapshotStale: seeded.stale
  }
}

/**
 * Character-based token estimate — the same conservative approximation the
 * renderer's context meter uses (`contextProjection.ts`), reused here since
 * Anodex has no real tokenizer for cloud models the way it does for the local
 * engine (`LlamaModel.tokenize`).
 */
function estimateTokensApprox(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN)
}

/**
 * Fold a prior context epoch summary into newly compacted turns.
 * Shared by the local engine and `boundHistoryForStatelessProvider` — both fold
 * a persisted snapshot's summary together with whatever gets freshly
 * compacted in the same turn.
 *
 * Fold `turns` into a bounded rolling summary via `foldIntoRollingSummary`,
 * chunking so no single summarizer call receives more transcript than its
 * small dedicated context can hold — the old single-call version handed the
 * entire overflow transcript over at once, which for a long-lived
 * conversation exceeded the summarizer's 4,096-token context and silently
 * degraded to dropping the turns unsummarized. Returns `null` when the slice
 * is too small to be worth summarizing (callers drop those turns, as
 * before).
 */
async function summarizeTurns(
  turns: ChatHistoryTurn[],
  summarizeOlderTurns: RollingSummarizer,
  countTokens: (text: string) => number,
  options?: { previousSummary?: string; chunkTokenBudget?: number }
): Promise<string | null> {
  if (turns.length === 0) return null
  const transcript = renderTurnsForSummary(turns)
  // Skipping a tiny INITIAL slice is a worthwhile round-trip optimization.
  // Once a rolling summary already exists, however, newly overflowing turns
  // must still be folded into it (the primitive uses a deterministic digest
  // for tiny chunks); otherwise the snapshot boundary advances past turns
  // that the summary never represented.
  if (transcript.length < MIN_CHARS_TO_SUMMARIZE && !options?.previousSummary) return null
  const folded = await foldIntoRollingSummary({
    items: turns,
    previousSummary: options?.previousSummary,
    renderTranscript: renderTurnsForSummary,
    itemTranscriptCost: (turn) => countTokens(renderTurnsForSummary([turn])),
    countTokens,
    summarize: summarizeOlderTurns,
    chunkTokenBudget: options?.chunkTokenBudget
  })
  return folded ?? null
}

/**
 * Older builds persisted a summary by concatenating every compaction. Re-fold
 * an oversized legacy value through the normal rolling primitive before it
 * reaches the model. Starting from no previous summary is intentional: this
 * entire value is source material, not a prefix to preserve verbatim.
 */
async function rebaseOversizedSummary(
  summary: string | undefined,
  countTokens: (text: string) => number,
  summarize: RollingSummarizer,
  chunkTokenBudget: number | undefined
): Promise<string | undefined> {
  if (!summary?.trim() || countTokens(summary) <= ROLLING_SUMMARY_TOKEN_CEILING) return summary
  return foldIntoRollingSummary({
    items: [summary],
    previousSummary: undefined,
    renderTranscript: (items) => items.join('\n\n'),
    itemTranscriptCost: (item) => countTokens(item),
    countTokens,
    summarize,
    chunkTokenBudget
  })
}

/**
 * Tools whose result is a snapshot of a file at a moment in time, so a later
 * identical call replaces rather than supplements it.
 *
 * `run_command` is absent on purpose: two identical commands can legitimately
 * return different things, and the earlier output may be the interesting one.
 */
const SNAPSHOT_READ_TOOLS = new Set([
  'read_file',
  'read_file_range',
  'read_multiple_files',
  'code_outline'
])

/** Tools that change a file, and so invalidate every earlier read of it. */
const WRITE_TOOLS = new Set(['write_file', 'append_file', 'edit_file', 'replace_lines'])

const SUPERSEDED_READ_NOTICE =
  '[superseded — this exact read was repeated later in the task, and the newer copy is the one that reflects the file now]'

const STALE_AFTER_WRITE_NOTICE =
  '[superseded — this file was edited after this read, so these line numbers and this content no longer match what is on disk. Read it again before editing it.]'

/**
 * Ids of snapshot reads that a later, identical read has replaced.
 *
 * Identity is the tool name plus its rendered title, and the title carries the
 * line range — so reading lines 1-50 and then 200-250 of one file leaves both
 * in place, because they are different content rather than a repeat. Only a
 * genuinely identical read is collapsed.
 *
 * A repeated read is one of two ways a copy goes bad, and it turned out to be
 * the less important one. The other is a *write*: once a file has been edited,
 * every earlier read of it describes a file that no longer exists, whatever the
 * range. That is the one that produced six rejected edits in a live run —
 * "line numbers are stale", "the text to replace was not found" — because
 * collapsing identical reads cannot help when the reads were never identical.
 * A write therefore supersedes every earlier read of the path it touched, and
 * says so, rather than leaving the model to discover it by failing.
 */
function supersededReadIds(history: ChatHistoryTurn[]): {
  repeated: Set<string>
  staleAfterWrite: Set<string>
} {
  const newestSeen = new Set<string>()
  const writtenSince = new Set<string>()
  const repeated = new Set<string>()
  const staleAfterWrite = new Set<string>()
  // Newest first, so the first sighting of an identity is the one that
  // survives, and any write is seen before the reads it invalidates.
  for (let turnIndex = history.length - 1; turnIndex >= 0; turnIndex--) {
    const calls = history[turnIndex]?.toolCalls
    if (!calls?.length) continue
    for (let callIndex = calls.length - 1; callIndex >= 0; callIndex--) {
      const call = calls[callIndex]
      if (call.status !== 'success') continue
      if (WRITE_TOOLS.has(call.name)) {
        for (const path of call.touchedPaths ?? []) writtenSince.add(path)
        continue
      }
      if (!SNAPSHOT_READ_TOOLS.has(call.name)) continue
      if ((call.touchedPaths ?? []).some((path) => writtenSince.has(path))) {
        staleAfterWrite.add(call.id)
        continue
      }
      const identity = `${call.name}::${call.title}`
      if (newestSeen.has(identity)) repeated.add(call.id)
      else newestSeen.add(identity)
    }
  }
  return { repeated, staleAfterWrite }
}

/**
 * The stand-in for a read the model has since repeated. The call itself stays
 * in the transcript — removing it would make the model's own history look as
 * though it never looked — but its body is replaced by a line saying where the
 * current copy is.
 */
function supersededReadMarker(call: ToolCall, notice: string): ToolCall {
  return { ...call, title: truncateToolTitle(call.title), result: notice, detail: undefined }
}

/** Sanitize transcript text and bound remembered tool output before model replay. */
export function projectHistoryForModel(history: ChatHistoryTurn[]): ChatHistoryTurn[] {
  const { repeated, staleAfterWrite } = supersededReadIds(history)
  return history.map((rawTurn) => {
    const turn = sanitizeHistoryTurn(rawTurn)
    if (turn.role !== 'assistant' || !turn.toolCalls?.length) return turn
    return {
      ...turn,
      toolCalls: turn.toolCalls.map((call) => {
        if (staleAfterWrite.has(call.id)) {
          return supersededReadMarker(call, STALE_AFTER_WRITE_NOTICE)
        }
        if (repeated.has(call.id)) return supersededReadMarker(call, SUPERSEDED_READ_NOTICE)
        return projectToolCallForModel(call)
      })
    }
  })
}

/** Return the compact, model-facing version of a tool call. */
export function projectToolCallForModel(call: ToolCall): ToolCall {
  return {
    ...call,
    title: truncateToolTitle(call.title),
    result: call.result ? truncateToolText(call.result) : call.result,
    detail: call.detail && !call.result ? truncateToolText(call.detail) : call.detail
  }
}

/** A compact, self-describing record of a past tool call for replay. */
export function rememberToolCallForModel(call: ToolCall): string {
  const projected = projectToolCallForModel(call)
  const body = projected.result ?? projected.detail ?? ''
  return body ? `${projected.title}\n${body}` : projected.title
}

/**
 * Token ceiling history replay may fill for the given window. After
 * system/reserved/tool-schema subtraction, an optional `recallWindowFraction`
 * keeps only that share for verbatim replay; the rest must be summarized or
 * dropped. Legacy null/omitted values are normalized before generation.
 * Exported so the exact cap maths can be unit-tested against the shared
 * `estimateProjectedContextUsage` mirror.
 */
export function historyBudgetTokens(
  systemPrompt: string | undefined,
  contextSize: number,
  countTokens: (text: string) => number,
  toolSchemaReserveTokens = 0,
  recallWindowFraction?: number | null
): number {
  const budget =
    contextSize -
    countTokens(systemPrompt ?? '') -
    reservedNonHistoryTokens(contextSize) -
    Math.max(0, toolSchemaReserveTokens)
  if (recallWindowFraction != null && Number.isFinite(recallWindowFraction)) {
    return Math.max(0, Math.floor(budget * recallWindowFraction))
  }
  return Math.max(0, budget)
}

/**
 * What the retained turns actually cost, measured the same way the budget that
 * selected them was.
 *
 * This had its own hand-rolled sum, and it disagreed with `turnTokenCost` in
 * two directions at once: it charged nothing for per-message framing, and
 * nothing for a tool call's title — so a call that recorded a title and no
 * result counted as zero. The figure it produces is what a developer reads out
 * of the compaction log while working out why a turn overflowed, and it read
 * low, which is the one direction that misleads.
 */
function historyTokens(
  history: ChatHistoryTurn[],
  countTokens: (text: string) => number,
  messageFramingTokens: number
): number {
  return history.reduce(
    (total, turn) => total + turnTokenCost(turn, countTokens, messageFramingTokens),
    0
  )
}

function truncateToolText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n')
  if (normalized.length <= MAX_MODEL_TOOL_RESULT_CHARS) return normalized
  return `${normalized.slice(0, MAX_MODEL_TOOL_RESULT_CHARS).trimEnd()}${TOOL_RESULT_TRUNCATION_NOTICE}`
}

function truncateToolTitle(title: string): string {
  if (title.length <= MAX_MODEL_TOOL_TITLE_CHARS) return title
  const keepChars = MAX_MODEL_TOOL_TITLE_CHARS - TOOL_TITLE_TRUNCATION_NOTICE.length
  return `${title.slice(0, keepChars).trimEnd()}${TOOL_TITLE_TRUNCATION_NOTICE}`
}

function lastTurnId(turns: ChatHistoryTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const id = turns[i]?.id
    if (id) return id
  }
  return null
}
