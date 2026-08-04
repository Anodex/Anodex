import { randomUUID } from 'node:crypto'
import type {
  ChatRequest,
  ContextBudgetUsage,
  GenerationStats,
  GenerationStopReason
} from '@shared/chat.types'
import type { ToolCall, ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import type { MemoryEntry } from '@shared/memory.types'
import type { WebSource } from '@shared/webSources.types'
import { WebSourceRegistry } from '../tools/WebSourceRegistry'
import type { VerificationResult } from '@shared/projectMemory.types'
import type { TranscriptRecallResult } from '@shared/transcriptRecall.types'
import type { ConversationContext } from '@shared/context.types'
import type { CheckpointSummary } from '@shared/checkpoint.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import type { PermissionMode, ProviderSettings } from '@shared/settings.types'
import { ANTHROPIC_MODELS } from '@shared/anthropicModels'
import { OPENAI_MODELS } from '@shared/openaiModels'
import { cloudContextWindowTokens } from '@shared/contextBudget'
import { composeSystemPrompt } from '@shared/prompts'
import { sanitizeAssistantContent } from '@shared/chatSanitizer'
import { getActiveProvider } from '../llm/ProviderRegistry'
import { llamaService, type GenerateOutcome, type GenerateParams } from '../llama/LlamaService'
import { boundHistoryForStatelessProvider } from '../llama/contextAssembler'
import { MESSAGE_FRAMING_TOKENS, visionToolSchemaReserveTokens } from '../llama/LlamaVisionService'
import { CLOUD_SUMMARY_CHUNK_TOKEN_BUDGET, summaryChunkBudgetForContext } from '../llama/compaction'
import { ROLLING_SUMMARY_TOKEN_CEILING } from '../llama/rollingSummary'
import { summarizeForCompactionOpenAi } from '../llm/OpenAiProvider'
import { summarizeForCompactionAnthropic } from '../llm/AnthropicProvider'
import { summarizeForCompactionAzure } from '../llm/AzureOpenAiProvider'
import { summarizeForCompactionOpenAiCompatible } from '../llm/OpenAiCompatibleProvider'
import { OPEN_AI_COMPATIBLE_CONFIGS, MODEL_CATALOGS_BY_PROVIDER } from '../llm/cloudProviderConfigs'
import { providerUsageStore } from '../llm/ProviderUsageStore'
import { settingsStore } from '../settings/SettingsStore'
import { projectStore } from '../projects/ProjectStore'
import { projectMemoryStore } from '../projects/ProjectMemoryStore'
import { tokenActivityStore } from '../stats/TokenActivityStore'
import { buildWorkspaceContext } from '../tools/workspaceContext'
import { buildMemoryContext } from '../memory/MemoryRetriever'
import { buildTranscriptRecallContext } from '../recall/transcriptRecallContext'
import { skillStore } from '../skills/SkillStore'
import { buildActiveSkillContext } from '../skills/activeSkillContext'
import { parseRunCommandVerification } from '../tools/commandTools'
import { mcpManager } from '../mcp/McpManager'
import type { ReadCoverageTracker } from '../tools/readCoverage'
import { chatEvents } from './chatEvents'
import { checkpointStore } from '../checkpoints/CheckpointStore'
import {
  GenerationBudget,
  interactiveBudgetForContext,
  type GenerationBudgetPolicy
} from './GenerationBudget'

/**
 * Everything a caller of {@link runGeneration} decides — how (or whether) to
 * surface live progress, and how tool calls get approved. An interactive IPC
 * caller (`chat.handlers.ts`) streams tokens/activity to a renderer window
 * and confirms writes/commands with a real user. A headless caller (scheduled
 * tasks) supplies neither: no one is watching tokens stream in, and approval
 * is decided up front by which tools the task owner opted in, not a modal.
 */
export interface RunGenerationIo {
  onToken?: (token: string) => void
  /** See `GenerateParams.onThinkingToken`'s doc comment. */
  onThinkingToken?: (token: string) => void
  onActivity?: (call: ToolCall) => void
  confirm: (request: ToolConfirmRequest) => Promise<ToolConfirmResponse>
  /** Restricts which tools get registered; undefined/null = unrestricted (normal chat). */
  enabledTools?: Set<string> | null
  /** Overrides the user's configured permission mode for this run (scheduled tasks force one). */
  permissionModeOverride?: PermissionMode
  /**
   * Use this provider (and, for a cloud provider, this model) instead of the
   * user's globally active one for this run — an agent run picking its own
   * provider. Never mutates the global setting; every other caller (omitting
   * this) behaves exactly as before.
   */
  providerOverride?: { provider: ProviderSettings['active']; model?: string }
  signal?: AbortSignal
  /**
   * Whether project/personal memory and past-chat recall may be injected into
   * this generation. Defaults to true. Evidence-only workflows such as
   * Critical Thinking disable it so uncited remembered text cannot silently
   * become part of a web-sourced report.
   */
  includeReferenceContext?: boolean
  /** Force a fresh local session for a bounded phase; cloud calls are already isolated. */
  sessionMode?: GenerateParams['sessionMode']
  /** Evidence focus and durable artifact sink for research-oriented callers. */
  evidenceFocus?: string
  onArtifact?: (artifact: ToolArtifact) => void
  /**
   * Shared web source registry for a caller-owned multi-cycle turn. Source ids
   * must be unique across the whole assistant message, so a runner that calls
   * `runGeneration` more than once for one reply has to own the registry —
   * otherwise each cycle restarts numbering at S1 and two different pages end
   * up citing the same id. Omitted for a single-shot call, which gets its own.
   */
  webSources?: WebSourceRegistry
  /** Optional stricter per-turn policy; interactive defaults remain bounded too. */
  executionBudget?: GenerationBudgetPolicy
  /**
   * Shared across every call in a caller-owned multi-cycle/multi-turn task
   * (see `ToolRuntimeContext.readCoverage`'s doc comment) — `BoundedChatRunner`
   * and `AgentRunService` supply one so read tools can trim a request down to
   * only its new portion (or short-circuit entirely) across cycle/turn
   * boundaries, not just within one call. Omit for a genuine one-shot
   * generation (e.g. Critical Thinking's isolated phases): a fresh, call-
   * scoped tracker is used instead, with no cross-call effect.
   */
  readCoverage?: ReadCoverageTracker
}

export interface RunGenerationResult {
  content: string
  stats: GenerationStats
  stopped: boolean
  /** Why `stopped` is true, when known — see `GenerateOutcome.stopReason`'s doc comment. */
  stopReason?: GenerationStopReason
  /** See `GenerateOutcome.stopDetail`'s doc comment. */
  stopDetail?: string
  /** Exact local fixed-context/tool accounting for this turn. */
  contextBudget?: ContextBudgetUsage
  /** Memory entries retrieved and injected into context for this turn, if any. */
  memoryUsed?: MemoryEntry[]
  /** Past-conversation excerpts retrieved and injected into context for this turn, if any. */
  transcriptRecallUsed?: TranscriptRecallResult[]
  /** Web pages this turn searched up or fetched, in the order the model first saw them. */
  webSources?: WebSource[]
  /**
   * True if any web tool ran this turn, regardless of what it returned. With an
   * empty `webSources` this is the "looked and found nothing" case, which the
   * source list alone cannot express.
   */
  webSearchAttempted?: boolean
  /**
   * A new compacted context snapshot produced this turn, if any — set on the
   * stateless-provider path (`boundHistoryForStatelessProvider`), which covers
   * every cloud provider plus the local llama-server transport. The
   * node-llama-cpp engine is the exception: it keeps its own in-memory
   * session/KV-cache continuity across turns within a run and compacts
   * internally. `chat.handlers.ts`'s interactive caller
   * already gets the same information via `chatEvents`' `historyCompacted`
   * event (forwarded to the renderer, which persists it through
   * `chatStore.applyHistoryCompaction`); a headless caller (`AgentRunService`,
   * `SchedulerService`) has no renderer listening on its behalf, so it must
   * persist this directly onto its own conversation record — otherwise every
   * subsequent turn in the same run re-summarizes the same growing history
   * from scratch instead of seeding from the snapshot already paid for.
   */
  context?: ConversationContext
  /** Restorable snapshot for file changes made by this assistant turn. */
  checkpoint?: CheckpointSummary
  /** See `GenerateOutcome.fabricationDetected`'s doc comment. */
  fabricationDetected?: boolean
  /** See `GenerateOutcome.thinking`'s doc comment. */
  thinking?: string
}

/**
 * The model that actually produced this turn, for token-activity stats.
 * Defaults to the globally active provider/model; `override` lets it reflect
 * what a run actually used instead (see `RunGenerationIo.providerOverride`) so
 * stats never misattribute to the global provider for an overridden run.
 * `llamaService.getState()` only describes the local engine, so a cloud
 * provider's turn is attributed to its own configured model instead of
 * whatever (if anything) is loaded locally.
 */
function activeModelDescriptor(
  provider: ProviderSettings,
  override?: RunGenerationIo['providerOverride']
): { id: string; name: string } | null {
  const activeId = override?.provider ?? provider.active
  if (activeId === 'anthropic') {
    const model = override?.model?.trim() || provider.anthropic.model
    return { id: model, name: `Claude — ${model}` }
  }
  if (activeId === 'openai') {
    const model = override?.model?.trim() || provider.openai.model
    return { id: model, name: `OpenAI — ${model}` }
  }
  if (activeId === 'azure') {
    const deployment = provider.azure.deploymentName.trim()
    return deployment ? { id: deployment, name: `Azure OpenAI — ${deployment}` } : null
  }
  if (activeId !== 'local') {
    const config = OPEN_AI_COMPATIBLE_CONFIGS[activeId]
    const model = override?.model?.trim() || provider[activeId].model
    return { id: model, name: `${config.displayName} — ${model}` }
  }
  const model = llamaService.getState().model
  return model ? { id: model.id, name: model.name } : null
}

/**
 * The narrow, tool-free summarizer this provider uses for context compaction,
 * bound to `modelOverride` (an agent/scheduled run's pinned model, if any) so
 * a run that never touches the globally-configured model doesn't have its
 * history silently summarized by that global model instead.
 */
function cloudSummarizer(
  providerId: Exclude<ProviderSettings['active'], 'local'>,
  modelOverride?: string
): (transcript: string, previousSummary?: string) => Promise<string | null> {
  if (providerId === 'anthropic') {
    return (transcript, previousSummary) =>
      summarizeForCompactionAnthropic(transcript, previousSummary, modelOverride)
  }
  if (providerId === 'openai') {
    return (transcript, previousSummary) =>
      summarizeForCompactionOpenAi(transcript, previousSummary, modelOverride)
  }
  if (providerId === 'azure') {
    return (transcript, previousSummary) => summarizeForCompactionAzure(transcript, previousSummary)
  }
  const config = OPEN_AI_COMPATIBLE_CONFIGS[providerId]
  return (transcript, previousSummary) =>
    summarizeForCompactionOpenAiCompatible(config, transcript, previousSummary, modelOverride)
}

/**
 * Model ids to sum today's token usage across for the provider usage gauge.
 * Anthropic/OpenAI use their own curated catalogs (kept as distinct named
 * exports predating the generic adapter); Azure has no catalog at all, so
 * its own resolved deployment name is the only "model id" that makes sense.
 *
 * The model that actually ran is always included, whatever the catalog says.
 * Usage is recorded against `modelDescriptor.id` a few lines later, so an id
 * the catalog doesn't list is spend the gauge can never see — and the two are
 * not guaranteed to agree over time: catalogs ship with the app while the
 * configured model is persisted settings, so a model retired from a catalog in
 * a later release would silently stop counting for anyone still pointed at it.
 * Azure already worked this way; the rest now do too.
 */
function cloudModelIdsForUsageQuery(
  providerId: Exclude<ProviderSettings['active'], 'local'>,
  modelDescriptor: { id: string }
): string[] {
  const catalog =
    providerId === 'anthropic'
      ? ANTHROPIC_MODELS.map((m) => m.id)
      : providerId === 'openai'
        ? OPENAI_MODELS.map((m) => m.id)
        : providerId === 'azure'
          ? []
          : MODEL_CATALOGS_BY_PROVIDER[providerId].map((m) => m.id)
  return catalog.includes(modelDescriptor.id) ? catalog : [...catalog, modelDescriptor.id]
}

/**
 * How this turn's history must be bounded before it is sent, or `null` when
 * the provider bounds its own.
 *
 * The dividing line is statefulness, not local-vs-cloud: only the
 * node-llama-cpp path keeps a session (and KV cache) that compacts internally.
 * Every other transport re-sends the whole conversation each request and needs
 * its history folded here — including Anodex's own llama-server transport,
 * which serves any local model carrying a multimodal projector. That case was
 * missed for as long as the check read `provider.active !== 'local'`, so those
 * conversations silently lost their oldest turns to character truncation
 * instead of summarizing them.
 */
export function resolveHistoryBounding(
  effectiveProviderId: ProviderSettings['active'],
  modelDescriptor: { id: string } | null,
  io: RunGenerationIo,
  hasTools = false
): {
  contextWindowTokens: number
  summarize: (transcript: string, previousSummary?: string) => Promise<string | null>
  summaryChunkTokenBudget: number
  /** Fixed schema overhead to hold back from history — see the same-named option on
   *  `boundHistoryForStatelessProvider`. */
  toolSchemaReserveTokens: number
  /** Per-message chat-template framing this transport pays; 0 where it isn't known. */
  messageFramingTokens: number
} | null {
  if (effectiveProviderId !== 'local') {
    if (!modelDescriptor) return null
    return {
      contextWindowTokens: cloudContextWindowTokens(effectiveProviderId, modelDescriptor.id),
      summarize: cloudSummarizer(effectiveProviderId, io.providerOverride?.model),
      summaryChunkTokenBudget: CLOUD_SUMMARY_CHUNK_TOKEN_BUDGET,
      // Left unreserved for now: a cloud window is 128K and up, where the
      // schema surface is a rounding error rather than the difference between
      // a full answer and a truncated one. The local case below is the one
      // that measurably ran out of room.
      toolSchemaReserveTokens: 0,
      messageFramingTokens: 0
    }
  }

  const local = llamaService.getState()
  if (!local.vision || !local.contextSize) return null
  return {
    contextWindowTokens: local.contextSize,
    summarize: (transcript, previousSummary) =>
      llamaService.summarizeForCompactionLocal(transcript, previousSummary),
    // Sized against the model's real context: this summarizer runs on the same
    // llama-server, so cloud-sized chunks could overflow the call meant to
    // relieve the overflow.
    summaryChunkTokenBudget: summaryChunkBudgetForContext(
      local.contextSize,
      ROLLING_SUMMARY_TOKEN_CEILING
    ),
    toolSchemaReserveTokens: visionToolSchemaReserveTokens(local.contextSize, hasTools),
    messageFramingTokens: MESSAGE_FRAMING_TOKENS
  }
}

/**
 * Runs one assistant turn: composes the system prompt (workspace context,
 * project rules, retrieved memory), builds the tool set if enabled, calls the
 * active provider, then records project memory and token-activity stats.
 *
 * The reusable core of what used to be `chat.handlers.ts`'s `Chat.send`
 * handler — extracted so a scheduled task can produce a real reply without an
 * `event.sender` to stream to or a user present to click an approval modal.
 * `chat.handlers.ts` is now a thin wrapper passing IPC-backed callbacks.
 */
export async function runGeneration(
  request: ChatRequest,
  io: RunGenerationIo
): Promise<RunGenerationResult> {
  const settings = settingsStore.get()
  const executionPolicy =
    io.executionBudget ??
    interactiveBudgetForContext(
      llamaService.getState().contextSize,
      settings.generation.turnTimeLimitMinutes
    )
  let execution: GenerationBudget | null = null
  const projects = projectStore.getState()
  // The renderer can briefly lag while switching chats, and general chats
  // intentionally clear the active project; deriving the root from
  // `request.projectId` (always present for a scheduled run) keeps project
  // chats writable and plain chats safe.
  const requestProjectId =
    'projectId' in request ? (request.projectId ?? null) : projects.activeProjectId
  const activeProject = projects.projects.find((p) => p.id === requestProjectId) ?? null
  const workspaceRoot = activeProject?.folderPath ?? null
  let hadToolActivity = false
  // Collects what the web tools retrieved this turn so the finished message can
  // show what it stood on — and, just as importantly, say so when the model
  // went looking and came back with nothing.
  const webSourceRegistry = io.webSources ?? new WebSourceRegistry()
  const toolNamesThisTurn: string[] = []
  // Real, verified outcomes this turn — for ProjectRecallEvent, as opposed to
  // the assistant's own prose claim about what it did. See recordEvent below.
  const successfulToolsThisTurn: string[] = []
  const failedToolsThisTurn: string[] = []
  const changedFilesThisTurn = new Set<string>()
  const verificationThisTurn: VerificationResult[] = []

  const tools = settings.tools.enabled
    ? {
        workspaceRoot,
        // Present whether or not a workspace is: the user attaching a file is
        // what makes it available to send, not having a project folder open.
        userFiles: request.userFiles ?? [],
        permissionMode: io.permissionModeOverride ?? settings.general.permissionMode,
        commandShell: settings.general.defaultShell.trim() || undefined,
        projectId: activeProject?.id ?? null,
        webSearch: settings.webSearch,
        email: settings.email,
        memory: {
          crossChatEnabled: settings.memory.crossChatEnabled,
          personalEnabled: settings.memory.personalEnabled,
          confirmBeforeSaving: settings.memory.confirmBeforeSaving
        },
        plan: request.plan ?? null,
        enabledTools: io.enabledTools ?? null,
        // Interactive chats use the persisted opt-out list. Headless runs
        // already have an explicit allowlist, so their behavior stays stable
        // even if the user later changes normal-chat preferences.
        disabledTools:
          io.enabledTools == null ? new Set(settings.tools.disabledTools) : new Set<string>(),
        // Discovery already happened at server-connect time, not here — this
        // is a synchronous read of McpManager's cache, so it never delays a
        // generation the way a live per-turn tool-list fetch would.
        mcpTools: mcpManager.listTools(),
        evidenceFocus: io.evidenceFocus,
        recordArtifact: io.onArtifact,
        webSources: webSourceRegistry,
        beforeTool: () => execution?.beforeTool() ?? null,
        onActivity: (call: ToolCall) => {
          hadToolActivity = true
          // Only tally terminal, actually-executed calls, matching the same
          // guard `LlamaService.generate()` uses before recording to
          // `modelReliabilityStore`.
          if (call.status === 'success') {
            toolNamesThisTurn.push(call.name)
            successfulToolsThisTurn.push(call.name)
            // Only a write-kind call's touchedPaths represents an actual change
            // (write/delete/move) — a read-kind call (read_file, preview_html,
            // etc.) also populates touchedPaths so its target shows up in the
            // "recently inspected" ledger, but must not count as "changed".
            if (call.kind === 'write') {
              for (const path of call.touchedPaths ?? []) changedFilesThisTurn.add(path)
            }
            const verification = parseRunCommandVerification(call)
            if (verification) verificationThisTurn.push(verification)
          } else if (call.status === 'error') {
            toolNamesThisTurn.push(call.name)
            failedToolsThisTurn.push(call.name)
          }
          io.onActivity?.(call)
        },
        confirm: io.confirm,
        readCoverage: io.readCoverage
      }
    : undefined

  const hasWorkspaceTools = settings.tools.enabled && Boolean(workspaceRoot)
  const includeReferenceContext = io.includeReferenceContext !== false
  const memory = includeReferenceContext
    ? buildMemoryContext(activeProject?.id ?? null, request.prompt, {
        crossChatEnabled: settings.memory.crossChatEnabled,
        personalEnabled: settings.memory.personalEnabled
      })
    : null

  // Resolved once and reused below for cloud-provider gating (transcript
  // recall, context bounding, before generation) and stats attribution
  // (after) — a cloud provider's turn must attribute to its own configured
  // model, not whatever's loaded locally.
  const modelDescriptor = activeModelDescriptor(settings.provider, io.providerOverride)
  const effectiveProviderId = io.providerOverride?.provider ?? settings.provider.active

  const transcriptRecall = includeReferenceContext
    ? buildTranscriptRecallContext({
        conversationId: request.conversationId,
        projectId: activeProject?.id ?? null,
        query: request.prompt,
        settings: settings.transcriptRecall,
        allowedForProvider:
          effectiveProviderId === 'local' || settings.transcriptRecall.cloudProviderEnabled
      })
    : null

  const activeSkillContext =
    activeProject && activeProject.pinnedSkillNames.length > 0
      ? buildActiveSkillContext(skillStore.list(workspaceRoot), activeProject.pinnedSkillNames)
      : null

  const systemPrompt = composeSystemPrompt({
    hasWorkspaceTools,
    hasProject: Boolean(activeProject),
    assistantStyle: settings.assistantStyle.globalStyle,
    projectRules: composeProjectRules(activeProject?.instructions, activeProject?.githubRepository),
    activeSkillContext,
    workspaceContext:
      hasWorkspaceTools && workspaceRoot
        ? buildWorkspaceContext(workspaceRoot, activeProject?.id ?? null, request.prompt)
        : null,
    memoryContext: memory?.text ?? null,
    transcriptRecallContext: transcriptRecall?.text ?? null
  })

  // The local engine applies persisted-snapshot seeding, real-tokenizer
  // budget splitting, and summarization internally (`LlamaService.generate`
  // → `compactHistoryForSession`). OpenAI/Anthropic have no such step of
  // their own and would otherwise replay the entire history every turn —
  // bound it here instead, using a conservative character-based token
  // estimate since there's no real tokenizer for a cloud model, and the same
  // provider's own narrow, tool-free summary call for overflow (isolated
  // from this turn's real generation, memory writes, usage stats, and
  // project activity recording). Turns that still don't fit after a failed
  // or degenerate summary are just omitted, and the renderer is notified
  // either way so it's visible rather than a silent context loss.
  let boundedSystemPrompt: string | undefined = systemPrompt
  let boundedHistory = request.history
  let contextUpdate: ConversationContext | undefined
  // `tools != null`, not `hasWorkspaceTools`: tool schemas are registered
  // whenever tools are enabled at all — a chat with no workspace folder still
  // carries the user-file, email and web surfaces, and so still pays for them.
  const bounding = resolveHistoryBounding(effectiveProviderId, modelDescriptor, io, tools != null)
  if (bounding) {
    const bounded = await boundHistoryForStatelessProvider(
      systemPrompt,
      request.history,
      request.context,
      bounding.contextWindowTokens,
      bounding.summarize,
      bounding.summaryChunkTokenBudget,
      {
        toolSchemaReserveTokens: bounding.toolSchemaReserveTokens,
        messageFramingTokens: bounding.messageFramingTokens
      }
    )
    boundedSystemPrompt = bounded.systemPrompt
    boundedHistory = bounded.history
    if (bounded.omittedTurns > 0) {
      chatEvents.emitHistoryCompacted({
        conversationId: request.conversationId,
        removedTurns: bounded.omittedTurns,
        reason: 'proactive',
        summarized: bounded.summarized,
        summary: bounded.summary,
        compactedThroughMessageId: bounded.compactedThroughMessageId,
        createdAt: Date.now()
      })
      // See `RunGenerationResult.context`'s doc comment — a headless caller
      // has no renderer to persist the snapshot the event above carries, so
      // hand it back directly too.
      if (bounded.summarized && bounded.summary && bounded.compactedThroughMessageId) {
        contextUpdate = {
          activeSnapshot: {
            id: randomUUID(),
            createdAt: Date.now(),
            reason: 'proactive',
            throughMessageId: bounded.compactedThroughMessageId,
            removedTurns: bounded.omittedTurns,
            summary: bounded.summary
          }
        }
      }
    }
  }

  let outcome: GenerateOutcome
  execution = new GenerationBudget(executionPolicy, io.signal)
  try {
    outcome = await getActiveProvider(io.providerOverride?.provider).generate({
      conversationId: request.conversationId,
      messageId: request.messageId,
      systemPrompt: boundedSystemPrompt,
      context: request.context,
      history: boundedHistory,
      prompt: request.prompt,
      images: request.images,
      sessionMode: io.sessionMode,
      options: request.options,
      modelOverride: io.providerOverride?.model,
      maxProviderRounds: executionPolicy.maxProviderRounds,
      onContextShift: () => execution?.recordContextShift(),
      signal: execution.signal,
      tools,
      onToken: (token) => io.onToken?.(token),
      onThinkingToken: (token) => io.onThinkingToken?.(token)
    })
  } finally {
    execution.dispose(io.signal)
  }

  // A budget ceiling never overrides a provider failure. Both can be true of
  // one turn — a 15-minute run that then hits a 429 trips the time limit and
  // the error — but only one of them is why the reply is missing, and the
  // budget's copy would tell the user to shorten a request whose real problem
  // was rate limiting. Anything else still wins as before, and takes the
  // detail with it so a stale message can't outlive the reason it belonged to.
  if (
    execution.stopReason &&
    execution.stopReason !== 'user' &&
    outcome.stopReason !== 'provider-error'
  ) {
    outcome = {
      ...outcome,
      stopped: true,
      stopReason: execution.stopReason,
      stopDetail: undefined
    }
  }

  const content = sanitizeAssistantContent(outcome.content)

  // Remember this turn in project memory so a future conversation in the
  // same project has ambient context, not just this one's chat history.
  // changedFiles/successfulTools/failedTools/verification come from real
  // tool outcomes, not the assistant's own claim; the reply text is kept
  // only as a supplemental, explicitly non-authoritative summary.
  //
  // Deliberately not gated on `!outcome.stopped`, as it once was. Everything
  // recorded here is a *completed* tool outcome — a file that was written, a
  // command that ran — and how the turn ended afterwards does not unwrite any
  // of it. The old gate dropped precisely the long, productive turns that a
  // bounded stop is designed to preserve (`rounds-exhausted`, `tool-limit`,
  // `time-limit`, `context-limit`, and now `provider-error`, all of which
  // report "the completed tool work above was preserved"), and this ledger
  // feeds `buildWorkspaceContext` — so the next turn's system prompt was left
  // with no record that those files had been touched at all. `recordEvent`
  // already drops an event carrying no real outcome, so nothing is gained by
  // filtering here as well.
  if (hadToolActivity && activeProject) {
    projectMemoryStore.recordEvent(activeProject.id, {
      conversationId: request.conversationId,
      messageId: request.messageId,
      changedFiles: [...changedFilesThisTurn],
      successfulTools: successfulToolsThisTurn,
      failedTools: failedToolsThisTurn,
      verification: verificationThisTurn,
      assistantSummary: content || undefined
    })
  }

  // Recorded regardless of `stopped` — real tokens were generated either way.
  // Either half being non-zero is enough: a turn that sent a large prompt and
  // came back with no output still cost real input tokens, and gating the whole
  // block on output alone kept that spend out of the daily-cap tally.
  if ((outcome.stats.tokens > 0 || (outcome.stats.inputTokens ?? 0) > 0) && modelDescriptor) {
    tokenActivityStore.recordGeneration({
      tokens: outcome.stats.tokens,
      // Every transport that re-sends the whole conversation each request
      // reports what that cost: the cloud providers from their own billed
      // usage, the llama-server vision transport from its `/tokenize`
      // measurement. Only the node-llama-cpp engine has no such figure — it
      // reuses its KV cache instead of re-billing — so it alone falls back to
      // the new-prompt proxy `countPromptTokens` is documented to be.
      inputTokens: outcome.stats.inputTokens ?? llamaService.countPromptTokens(request.prompt),
      durationMs: outcome.stats.durationMs,
      toolNames: toolNamesThisTurn,
      conversationId: request.conversationId,
      modelId: modelDescriptor.id,
      modelName: modelDescriptor.name
    })

    // Refresh the cloud provider usage gauge with today's new total — keyed
    // by whichever provider actually ran (an override, if this run has one,
    // not necessarily the global setting) — the daily-cap comparison lives
    // entirely on this local tally, not on anything the provider itself reports.
    if (effectiveProviderId !== 'local') {
      providerUsageStore.recordTodayTokens(
        effectiveProviderId,
        tokenActivityStore.getTodayTokensForModelIds(
          cloudModelIdsForUsageQuery(effectiveProviderId, modelDescriptor)
        )
      )
    }
  }

  return {
    content,
    stats: outcome.stats,
    stopped: outcome.stopped,
    stopReason: outcome.stopReason,
    stopDetail: outcome.stopDetail,
    contextBudget: outcome.contextBudget,
    memoryUsed: memory?.entries,
    transcriptRecallUsed: transcriptRecall?.results,
    webSources: webSourceRegistry.list(),
    webSearchAttempted: webSourceRegistry.attempted,
    context: contextUpdate,
    checkpoint:
      activeProject && workspaceRoot
        ? (checkpointStore.getSummary(workspaceRoot, request.conversationId, request.messageId) ??
          undefined)
        : undefined,
    fabricationDetected: outcome.fabricationDetected,
    thinking: outcome.thinking
  }
}

function composeProjectRules(
  instructions: string | undefined,
  githubRepository: string | undefined
): string | null {
  const parts = [instructions?.trim()]
  if (githubRepository) {
    parts.push(
      `The active project is linked to the GitHub repository ${githubRepository}. Use that owner/repository as the default target for GitHub tools unless the user names another repository.`
    )
  }
  return parts.filter((part): part is string => Boolean(part)).join('\n\n') || null
}
