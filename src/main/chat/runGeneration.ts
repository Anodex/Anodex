import type { ChatRequest, GenerationStats } from '@shared/chat.types'
import type { ToolCall, ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import type { MemoryEntry } from '@shared/memory.types'
import type { VerificationResult } from '@shared/projectMemory.types'
import type { TranscriptRecallResult } from '@shared/transcriptRecall.types'
import type { PermissionMode, ProviderSettings } from '@shared/settings.types'
import { ANTHROPIC_MODELS } from '@shared/anthropicModels'
import { OPENAI_MODELS } from '@shared/openaiModels'
import { DEFAULT_CLOUD_CONTEXT_WINDOW_TOKENS } from '@shared/contextBudget'
import { composeSystemPrompt } from '@shared/prompts'
import { sanitizeAssistantContent } from '@shared/chatSanitizer'
import { getActiveProvider } from '../llm/ProviderRegistry'
import { llamaService } from '../llama/LlamaService'
import { boundHistoryForCloudProvider } from '../llama/contextAssembler'
import { summarizeForCompactionOpenAi } from '../llm/OpenAiProvider'
import { summarizeForCompactionAnthropic } from '../llm/AnthropicProvider'
import { providerUsageStore } from '../llm/ProviderUsageStore'
import { settingsStore } from '../settings/SettingsStore'
import { projectStore } from '../projects/ProjectStore'
import { projectMemoryStore } from '../projects/ProjectMemoryStore'
import { tokenActivityStore } from '../stats/TokenActivityStore'
import { buildWorkspaceContext } from '../tools/workspaceContext'
import { buildMemoryContext } from '../memory/MemoryRetriever'
import { buildTranscriptRecallContext } from '../recall/transcriptRecallContext'
import { parseRunCommandVerification } from '../tools/commandTools'
import { chatEvents } from './chatEvents'

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
  providerOverride?: { provider: 'local' | 'anthropic' | 'openai'; model?: string }
  signal?: AbortSignal
}

export interface RunGenerationResult {
  content: string
  stats: GenerationStats
  stopped: boolean
  /** Memory entries retrieved and injected into context for this turn, if any. */
  memoryUsed?: MemoryEntry[]
  /** Past-conversation excerpts retrieved and injected into context for this turn, if any. */
  transcriptRecallUsed?: TranscriptRecallResult[]
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
  const model = llamaService.getState().model
  return model ? { id: model.id, name: model.name } : null
}

/**
 * Conservative context-window budget for a cloud model, used to bound
 * history before it's sent (see `boundHistoryForCloudProvider`). Falls back
 * to `DEFAULT_CLOUD_CONTEXT_WINDOW_TOKENS` for a custom/typed-in model id
 * with no known catalog entry, so an unrecognized model still gets bounded
 * instead of replaying history unboundedly.
 */
function cloudContextWindowTokens(providerId: 'openai' | 'anthropic', modelId: string): number {
  const models = providerId === 'anthropic' ? ANTHROPIC_MODELS : OPENAI_MODELS
  return (
    models.find((m) => m.id === modelId)?.contextWindowTokens ?? DEFAULT_CLOUD_CONTEXT_WINDOW_TOKENS
  )
}

/** The narrow, tool-free summarizer this provider uses for context compaction. */
function cloudSummarizer(
  providerId: 'openai' | 'anthropic'
): (transcript: string) => Promise<string | null> {
  return providerId === 'anthropic' ? summarizeForCompactionAnthropic : summarizeForCompactionOpenAi
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
        permissionMode: io.permissionModeOverride ?? settings.general.permissionMode,
        commandShell: settings.general.defaultShell.trim() || undefined,
        projectId: activeProject?.id ?? null,
        webSearch: settings.webSearch,
        email: settings.email,
        memory: {
          crossChatEnabled: settings.memory.crossChatEnabled,
          personalEnabled: settings.memory.personalEnabled
        },
        plan: request.plan ?? null,
        enabledTools: io.enabledTools ?? null,
        onActivity: (call: ToolCall) => {
          hadToolActivity = true
          // Only tally terminal, actually-executed calls, matching the same
          // guard `LlamaService.generate()` uses before recording to
          // `modelReliabilityStore`.
          if (call.status === 'success') {
            toolNamesThisTurn.push(call.name)
            successfulToolsThisTurn.push(call.name)
            for (const path of call.touchedPaths ?? []) changedFilesThisTurn.add(path)
            const verification = parseRunCommandVerification(call)
            if (verification) verificationThisTurn.push(verification)
          } else if (call.status === 'error') {
            toolNamesThisTurn.push(call.name)
            failedToolsThisTurn.push(call.name)
          }
          io.onActivity?.(call)
        },
        confirm: io.confirm
      }
    : undefined

  const hasWorkspaceTools = settings.tools.enabled && Boolean(workspaceRoot)
  const memory = buildMemoryContext(activeProject?.id ?? null, request.prompt, {
    crossChatEnabled: settings.memory.crossChatEnabled,
    personalEnabled: settings.memory.personalEnabled
  })

  // Resolved once and reused below for cloud-provider gating (transcript
  // recall, context bounding, before generation) and stats attribution
  // (after) — a cloud provider's turn must attribute to its own configured
  // model, not whatever's loaded locally.
  const modelDescriptor = activeModelDescriptor(settings.provider, io.providerOverride)
  const effectiveProviderId = io.providerOverride?.provider ?? settings.provider.active

  const transcriptRecall = buildTranscriptRecallContext({
    conversationId: request.conversationId,
    projectId: activeProject?.id ?? null,
    query: request.prompt,
    settings: settings.transcriptRecall,
    allowedForProvider:
      effectiveProviderId === 'local' || settings.transcriptRecall.cloudProviderEnabled
  })

  const systemPrompt = composeSystemPrompt({
    hasWorkspaceTools,
    hasProject: Boolean(activeProject),
    assistantStyle: settings.assistantStyle.globalStyle,
    projectRules: activeProject?.instructions ?? null,
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
  if (
    (effectiveProviderId === 'openai' || effectiveProviderId === 'anthropic') &&
    modelDescriptor
  ) {
    const bounded = await boundHistoryForCloudProvider(
      systemPrompt,
      request.history,
      request.context,
      cloudContextWindowTokens(effectiveProviderId, modelDescriptor.id),
      cloudSummarizer(effectiveProviderId)
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
    }
  }

  const outcome = await getActiveProvider(io.providerOverride?.provider).generate({
    conversationId: request.conversationId,
    messageId: request.messageId,
    systemPrompt: boundedSystemPrompt,
    context: request.context,
    history: boundedHistory,
    prompt: request.prompt,
    options: request.options,
    modelOverride: io.providerOverride?.model,
    signal: io.signal,
    tools,
    onToken: (token) => io.onToken?.(token)
  })

  const content = sanitizeAssistantContent(outcome.content)

  // Remember this turn in project memory so a future conversation in the
  // same project has ambient context, not just this one's chat history.
  // changedFiles/successfulTools/failedTools/verification come from real
  // tool outcomes, not the assistant's own claim; the reply text is kept
  // only as a supplemental, explicitly non-authoritative summary.
  if (hadToolActivity && !outcome.stopped && activeProject) {
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
  if (outcome.stats.tokens > 0 && modelDescriptor) {
    tokenActivityStore.recordGeneration({
      tokens: outcome.stats.tokens,
      inputTokens: llamaService.countPromptTokens(request.prompt),
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
    if (effectiveProviderId === 'anthropic' || effectiveProviderId === 'openai') {
      const modelIds =
        effectiveProviderId === 'anthropic'
          ? ANTHROPIC_MODELS.map((m) => m.id)
          : OPENAI_MODELS.map((m) => m.id)
      providerUsageStore.recordTodayTokens(
        effectiveProviderId,
        tokenActivityStore.getTodayTokensForModelIds(modelIds)
      )
    }
  }

  return {
    content,
    stats: outcome.stats,
    stopped: outcome.stopped,
    memoryUsed: memory?.entries,
    transcriptRecallUsed: transcriptRecall?.results
  }
}
