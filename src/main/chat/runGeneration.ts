import type { ChatRequest, GenerationStats } from '@shared/chat.types'
import type { ToolCall, ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import type { MemoryEntry } from '@shared/memory.types'
import type { PermissionMode, ProviderSettings } from '@shared/settings.types'
import { ANTHROPIC_MODELS } from '@shared/anthropicModels'
import { OPENAI_MODELS } from '@shared/openaiModels'
import { composeSystemPrompt } from '@shared/prompts'
import { sanitizeAssistantContent } from '@shared/chatSanitizer'
import { getActiveProvider } from '../llm/ProviderRegistry'
import { llamaService } from '../llama/LlamaService'
import { providerUsageStore } from '../llm/ProviderUsageStore'
import { settingsStore } from '../settings/SettingsStore'
import { projectStore } from '../projects/ProjectStore'
import { projectMemoryStore } from '../projects/ProjectMemoryStore'
import { tokenActivityStore } from '../stats/TokenActivityStore'
import { buildWorkspaceContext } from '../tools/workspaceContext'
import { buildMemoryContext } from '../memory/MemoryRetriever'

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

  const tools = settings.tools.enabled
    ? {
        workspaceRoot,
        permissionMode: io.permissionModeOverride ?? settings.general.permissionMode,
        commandShell: settings.general.defaultShell.trim() || undefined,
        projectId: activeProject?.id ?? null,
        webSearch: settings.webSearch,
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
          if (call.status === 'success' || call.status === 'error') {
            toolNamesThisTurn.push(call.name)
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
  const systemPrompt = composeSystemPrompt({
    hasWorkspaceTools,
    hasProject: Boolean(activeProject),
    workspaceContext:
      hasWorkspaceTools && workspaceRoot
        ? buildWorkspaceContext(workspaceRoot, activeProject?.id ?? null, request.prompt)
        : null,
    memoryContext: memory?.text ?? null,
    projectRules: activeProject?.instructions ?? null,
    userInstructions: settings.ui.systemPrompt
  })

  const outcome = await getActiveProvider(io.providerOverride?.provider).generate({
    conversationId: request.conversationId,
    messageId: request.messageId,
    systemPrompt,
    context: request.context,
    history: request.history,
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
  if (hadToolActivity && !outcome.stopped && activeProject && content) {
    projectMemoryStore.recordSummary(activeProject.id, request.conversationId, content)
  }

  // Recorded regardless of `stopped` — real tokens were generated either way.
  const modelDescriptor = activeModelDescriptor(settings.provider, io.providerOverride)
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
    const effectiveProviderId = io.providerOverride?.provider ?? settings.provider.active
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
    memoryUsed: memory?.entries
  }
}
