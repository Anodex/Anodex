import OpenAI, { APIUserAbortError } from 'openai'
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionToolMessageParam
} from 'openai/resources/chat/completions'
import type { ChatHistoryTurn, ChatImageInput, GenerationStats } from '@shared/chat.types'
import type { CloudProviderSettings } from '@shared/settings.types'
import type { GenerateOutcome, GenerateParams } from '../llama/LlamaService'
import { projectHistoryForModel, rememberToolCallForModel } from '../llama/contextAssembler'
import {
  buildCompactionSummaryPrompt,
  buildCompactionUpdatePrompt,
  MAX_COMPACTION_SUMMARY_TOKENS,
  MIN_SUMMARY_CHARS
} from '../llama/compaction'
import { buildTools } from '../tools/registry'
import { createLoopGuardState } from '../tools/loopGuard'
import { createReadCoverageTracker } from '../tools/readCoverage'
import type { DefineChatSessionFunction, ToolFunction } from '../tools/types'
import type { ModelToolResultBudget } from '../tools/modelResultBudget'
import { toolParameterSchema } from '../tools/toolParameterSchema'
import { cloudContextWindowTokens, type CloudProvider } from '@shared/contextBudget'
import {
  advanceCloudSpentTokens,
  cloudToolResultBudget,
  estimateCloudSpentTokens
} from './cloudRoundBudget'
import { settingsStore } from '../settings/SettingsStore'
import { tokenActivityStore } from '../stats/TokenActivityStore'
import { createLogger } from '../utils/logger'
import { COMPACTION_TIMEOUT_MS, VERIFY_KEY_TIMEOUT_MS } from './cloudTimeouts'
import { toStopDetail } from '@shared/stopDetail'
import { appendRoundText } from '@shared/roundText'
import type { LlmProvider } from './LlmProvider'
import { chatCompletionsUserContent, cloudCompatibleImages } from './cloudVisionContent'
import { createTurnProgress } from '../tools/turnProgress'
import {
  assertCloudVisionCompatible,
  CLOUD_VISION_MIME_TYPES,
  createVisualInputQueue,
  drainVisualInputs,
  MAX_VISION_IMAGES,
  reopenPinnedHistoryImages,
  selectCurrentVisionImages
} from '../vision/imageInputs'

const log = createLogger('cloud-provider')

const DEFAULT_MAX_TOKENS = 4096
/**
 * Cap on tool-use round trips within a single generation, matching every
 * other provider's own cap (`AnthropicProvider.ts`/`OpenAiProvider.ts`) —
 * bounds a model stuck repeatedly calling tools without ever finishing.
 */
const MAX_TOOL_ROUNDS = 20

/**
 * Trivial local stand-in for node-llama-cpp's `defineChatSessionFunction` —
 * see `AnthropicProvider.ts` for the full explanation. Reused here so every
 * provider shares the exact same tool factories as the local engine.
 */
const defineToolFunction = ((fn) => fn) as DefineChatSessionFunction

/**
 * The subset of `ProviderSettings` keys whose settings are the plain
 * `{apiKey, model, dailyTokenCap}` shape this adapter reads. Anthropic,
 * OpenAI (both have their own bespoke `LlmProvider`), and Azure (a distinct
 * shape — see `AzureOpenAiProvider.ts`) are deliberately excluded.
 */
export type OpenAiCompatibleProviderId =
  'google' | 'xai' | 'deepseek' | 'mistral' | 'groq' | 'openrouter' | 'kimi' | 'qwen'

/**
 * Static description of one OpenAI-Chat-Completions-compatible cloud
 * provider. Most third-party model APIs (xAI, DeepSeek, Mistral, Groq,
 * OpenRouter, Moonshot/Kimi, Alibaba Qwen, and Google Gemini's own
 * OpenAI-compat endpoint) implement this exact wire protocol — a single
 * generic adapter covers all of them instead of one bespoke ~400-line file
 * per provider, matching this project's stated aversion to duplicated
 * near-identical code. OpenAI's own direct provider stays on the separate
 * `OpenAiProvider.ts` (it uses the newer Responses API, not Chat
 * Completions); Azure OpenAI stays on `AzureOpenAiProvider.ts` (same wire
 * protocol, but a different client/auth/URL shape) — both reuse
 * `runChatCompletionsLoop` below rather than duplicating it.
 */
export interface OpenAiCompatibleConfig {
  id: OpenAiCompatibleProviderId
  /** Human-readable name used in error messages and token-activity attribution. */
  displayName: string
  /** Base URL for this provider's OpenAI-compatible endpoint. */
  baseURL: string
  /** Model id used when neither a per-call override nor a saved setting is present. */
  defaultModel: string
}

function readSettings(id: OpenAiCompatibleProviderId): CloudProviderSettings {
  return settingsStore.get().provider[id]
}

/**
 * A cloud provider backed by any OpenAI-compatible Chat Completions API.
 * Implements the same `LlmProvider` contract as the local engine and every
 * other cloud provider, reusing the same tool factories, history
 * sanitization, and tool-call replay conventions so a conversation reads the
 * same regardless of which provider produced it.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(private readonly config: OpenAiCompatibleConfig) {}

  get id(): string {
    return this.config.id
  }

  async generate(params: GenerateParams): Promise<GenerateOutcome> {
    const settings = readSettings(this.config.id)
    const apiKey = settings.apiKey.trim()
    if (!apiKey) {
      throw new Error(
        `No ${this.config.displayName} API key configured. Add one in Settings → AI & Models → Cloud models.`
      )
    }

    const client = new OpenAI({ apiKey, baseURL: this.config.baseURL })
    const model = params.modelOverride?.trim() || settings.model.trim() || this.config.defaultModel
    return runChatCompletionsLoop(
      client,
      model,
      params,
      this.config.id,
      this.config.id === 'google' ? { provider: 'google' } : undefined
    )
  }
}

/**
 * The tool-calling generation loop shared by every Chat-Completions-shaped
 * provider — both this file's generic adapter and `AzureOpenAiProvider.ts`
 * (same wire protocol, different client construction/auth) call this with an
 * already-built client, rather than duplicating the loop. Anthropic and
 * OpenAI's own direct provider each have their own loop already (different
 * wire protocols entirely), so this isn't a candidate to unify further.
 */
export async function runChatCompletionsLoop(
  client: OpenAI,
  model: string,
  params: GenerateParams,
  /** Which catalog to size this model's context window against. */
  providerId: CloudProvider,
  imageGeneration?: { provider: 'google' }
): Promise<GenerateOutcome> {
  const visualInputs = createVisualInputQueue(MAX_VISION_IMAGES, CLOUD_VISION_MIME_TYPES)
  const contextWindowTokens = cloudContextWindowTokens(providerId, model)
  const modelResultBudgetBox: { current: ModelToolResultBudget | null } = { current: null }

  const toolFunctions = params.tools
    ? buildTools(defineToolFunction, {
        conversationId: params.conversationId,
        messageId: params.messageId,
        workspaceRoot: params.tools.workspaceRoot,
        userFiles: params.tools.userFiles,
        projectId: params.tools.projectId,
        permissionMode: params.tools.permissionMode,
        commandShell: params.tools.commandShell,
        webSearch: params.tools.webSearch,
        imageGeneration,
        email: params.tools.email,
        memory: params.tools.memory,
        goalRun: params.tools.goalRun,
        enabledTools: params.tools.enabledTools ?? null,
        disabledTools: params.tools.disabledTools,
        mcpTools: params.tools.mcpTools,
        evidenceFocus: params.tools.evidenceFocus,
        recordArtifact: params.tools.recordArtifact,
        webSources: params.tools.webSources,
        beforeTool: params.tools.beforeTool,
        // A mutable box, not the plan value itself — shared by every tool
        // call in this generation, matching LlamaService's own wiring.
        plan: { current: params.tools.plan },
        // Fresh every generation call, no seeding needed (unlike `plan`) —
        // see `ToolRuntimeContext.turnGate`'s doc comment.
        turnGate: { approved: false },
        // Fresh every generation call, same reasoning as `turnGate` above —
        // see `ToolRuntimeContext.loopGuard`'s doc comment.
        loopGuard: params.tools.loopGuard ?? createLoopGuardState(),
        // Fresh every generation call, same reasoning as `turnGate` above —
        // see `ToolRuntimeContext.progress`'s doc comment.
        progress: createTurnProgress(),
        // Sized from the model's real window and this turn's own reported
        // usage each round — see `cloudRoundBudget.ts`. Left permanently null
        // (as this did) every tool falls back to its own disk-oriented cap,
        // and 20 rounds of 60 KB reads overrun even a 200K window.
        modelResultBudget: modelResultBudgetBox,
        // Reuse the caller-owned tracker when this call is part of a
        // bounded multi-cycle/multi-turn task; otherwise a fresh one.
        readCoverage: params.tools.readCoverage ?? createReadCoverageTracker(),
        visualInputs,
        signal: params.signal,
        emit: params.tools.onActivity,
        confirm: params.tools.confirm
      })
    : undefined

  const tools = toolFunctions ? toChatCompletionTools(toolFunctions) : undefined

  const currentImages = selectCurrentVisionImages(params.images)
  assertCloudVisionCompatible(currentImages)
  const historyImages = await reopenPinnedHistoryImages(
    params.history,
    MAX_VISION_IMAGES - currentImages.length
  )
  // Merged only once the current prompt has joined the list — history that
  // ends on a user turn plus this prompt is itself an adjacent pair, so
  // merging inside `buildMessages` alone would miss the commonest case.
  // Everything appended later is assistant/tool, which alternates by
  // construction.
  const messages = mergeConsecutiveRoles([
    ...buildMessages(params.systemPrompt, params.history, historyImages),
    { role: 'user', content: chatCompletionsUserContent(params.prompt, currentImages) }
  ])

  const maxTokens = params.options?.maxTokens || DEFAULT_MAX_TOKENS
  const startedAt = Date.now()
  let content = ''
  let outputTokens = 0
  // Summed across rounds — each tool round re-bills the whole conversation.
  let inputTokens = 0
  let stopped = false
  /** Whether any tool actually ran this turn — work a later failure must not discard. */
  let hadToolResult = false

  const maxToolRounds = params.maxProviderRounds ?? MAX_TOOL_ROUNDS
  let roundsExhausted = false
  /** Set when a round failed after earlier ones had already produced work. */
  let providerError: string | null = null
  // Round 0 has no reported usage to size against yet, so estimate; every round
  // after this folds in the provider's own exact figure. No `systemPrompt` here:
  // `buildMessages` puts it inside `messages` as a system-role entry, so passing
  // it again would count it twice.
  let spentInputTokens = estimateCloudSpentTokens(contextWindowTokens, {
    rendered: messages,
    tools
  })
  modelResultBudgetBox.current = cloudToolResultBudget(contextWindowTokens, spentInputTokens)
  for (let round = 0; round < maxToolRounds; round++) {
    if (params.signal?.aborted) {
      stopped = true
      break
    }

    const stream = client.chat.completions.stream(
      {
        model,
        max_tokens: maxTokens,
        messages,
        tools
      },
      { signal: params.signal }
    )

    // Per round, not per turn: folded into `content` below with a separator, so
    // narration before a tool call does not run into the answer after it.
    // Streaming stays raw — the renderer replaces its own accumulation with the
    // authoritative `content` when the turn finishes, same as the local path.
    let roundContent = ''
    stream.on('content', (delta) => {
      roundContent += delta
      params.onToken(delta)
    })

    let completion: OpenAI.ChatCompletion
    try {
      completion = await stream.finalChatCompletion()
      content = appendRoundText(content, roundContent)
    } catch (error) {
      // Folded before anything below reads `content`, so a round that streamed
      // real text before failing is judged on what it produced.
      content = appendRoundText(content, roundContent)
      if (params.signal?.aborted || error instanceof APIUserAbortError) {
        stopped = true
        break
      }
      // Throwing discards the whole outcome. On round 0 that costs nothing and
      // the error message is the entire value, so it still throws. Once earlier
      // rounds have produced text or run tools, it costs all of it — and
      // `boundedChatRunner` has no catch of its own, so a multi-cycle reply
      // loses every previous cycle too. Report it as a stop carrying the
      // provider's own message instead; it still renders as a real error.
      if (!content && !hadToolResult) throw error
      providerError = toStopDetail(error) ?? 'The provider gave no reason.'
      log.error(`${model} failed mid-turn; keeping the work already done:`, error)
      break
    }

    outputTokens += completion.usage?.completion_tokens ?? 0
    inputTokens += completion.usage?.prompt_tokens ?? 0
    // The provider's own count for the prompt it just processed — exact, and it
    // already covers the system prompt, tool schemas and every message so far,
    // which is precisely what the next result has to fit alongside.
    spentInputTokens = advanceCloudSpentTokens(spentInputTokens, completion.usage?.prompt_tokens)
    modelResultBudgetBox.current = cloudToolResultBudget(contextWindowTokens, spentInputTokens)

    const message = completion.choices[0]?.message
    const toolCalls = (message?.tool_calls ?? []).filter(
      (call): call is Extract<ChatCompletionMessageToolCall, { type: 'function' }> =>
        call.type === 'function'
    )
    if (toolCalls.length === 0 || !toolFunctions) break
    // There is no remaining provider round in which the model could consume
    // these results. Do not execute side effects that cannot influence a reply.
    if (round === maxToolRounds - 1) {
      roundsExhausted = true
      break
    }

    // Replay the assistant turn (text + tool calls) then execute every
    // requested tool and feed each result back as its own `tool` message,
    // per the Chat Completions tool-use protocol.
    const assistantMessage: ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: message?.content ?? null,
      tool_calls: toolCalls
    }
    messages.push(assistantMessage)

    for (const call of toolCalls) {
      messages.push(await runTool(toolFunctions, call))
    }
    hadToolResult = true
    const inspectionImages = drainVisualInputs(visualInputs)
    assertCloudVisionCompatible(inspectionImages)
    if (inspectionImages.length > 0) {
      messages.push({
        role: 'user',
        content: chatCompletionsUserContent(
          'Inspect this visual output carefully. Use what you see to continue the task, and revise the work when needed.',
          inspectionImages
        )
      })
    }
  }

  const durationMs = Math.max(1, Date.now() - startedAt)
  const stats: GenerationStats = {
    tokens: outputTokens,
    durationMs,
    tokensPerSecond: outputTokens / (durationMs / 1000),
    inputTokens
  }

  return {
    content,
    stats,
    stopped: stopped || roundsExhausted || providerError !== null,
    // A provider failure outranks a round budget: it is why the turn actually
    // ended, and it is the only one of the two the user can act on.
    stopReason: providerError
      ? 'provider-error'
      : roundsExhausted
        ? 'rounds-exhausted'
        : stopped
          ? 'user'
          : undefined,
    stopDetail: providerError ?? undefined
  }
}

/** Execute a single tool call and translate its outcome into a `tool` message. */
async function runTool(
  toolFunctions: Record<string, ToolFunction>,
  call: Extract<ChatCompletionMessageToolCall, { type: 'function' }>
): Promise<ChatCompletionToolMessageParam> {
  const tool = toolFunctions[call.function.name]
  if (!tool) {
    return {
      role: 'tool',
      tool_call_id: call.id,
      content: `Unknown tool "${call.function.name}".`
    }
  }
  try {
    const args: unknown = call.function.arguments ? JSON.parse(call.function.arguments) : {}
    const result: unknown = await tool.handler(args)
    return {
      role: 'tool',
      tool_call_id: call.id,
      content: typeof result === 'string' ? result : JSON.stringify(result)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(`Tool "${call.function.name}" threw:`, error)
    return { role: 'tool', tool_call_id: call.id, content: `Error: ${message}` }
  }
}

/**
 * Collapses consecutive same-role messages into one.
 *
 * A turn with no text and no images is skipped when building the request —
 * an assistant turn that errored or was stopped is still persisted into
 * history, so this is ordinary. Skipping it leaves the two user turns either
 * side of it adjacent, and while most OpenAI-compatible endpoints tolerate
 * that, Mistral and Google's compat layer have historically required strict
 * alternation.
 *
 * Merging rather than dropping or inventing a placeholder: nothing the user
 * said is lost, and the result is what the conversation actually was — someone
 * saying two things without an answer in between. Anthropic's API does exactly
 * this server-side, which is why its own provider needs no equivalent.
 */
function mergeConsecutiveRoles(
  messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  const merged: ChatCompletionMessageParam[] = []
  for (const message of messages) {
    const previous = merged[merged.length - 1]
    // Only user and assistant alternate; system and tool messages have their
    // own placement rules and are never merged.
    const mergeable =
      previous !== undefined &&
      previous.role === message.role &&
      (message.role === 'user' || message.role === 'assistant')
    if (!mergeable) {
      merged.push(message)
      continue
    }
    merged[merged.length - 1] = {
      ...previous,
      content: joinContent(previous.content, message.content)
    } as ChatCompletionMessageParam
  }
  return merged
}

/** Joins two message contents, promoting to parts when either side carries images. */
function joinContent(
  left: ChatCompletionMessageParam['content'],
  right: ChatCompletionMessageParam['content']
): string | ChatCompletionContentPart[] {
  const leftText = typeof left === 'string' ? left : null
  const rightText = typeof right === 'string' ? right : null
  if (leftText !== null && rightText !== null) {
    return [leftText, rightText].filter(Boolean).join('\n\n')
  }
  const toParts = (value: ChatCompletionMessageParam['content']): ChatCompletionContentPart[] => {
    if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : []
    return Array.isArray(value) ? (value as ChatCompletionContentPart[]) : []
  }
  return [...toParts(left), ...toParts(right)]
}

/**
 * Project the system prompt and prior turns into Chat Completions messages,
 * folding remembered tool calls into the assistant's text using the same
 * compact, self-describing convention every other provider replays
 * (`rememberToolCallForModel`) — so a conversation that switches providers
 * mid-history still reads consistently.
 */
function buildMessages(
  systemPrompt: string | undefined,
  history: ChatHistoryTurn[],
  imagesByTurn: ReadonlyMap<number, ChatImageInput[]>
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = []
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
  const projected = projectHistoryForModel(history)
  for (let index = 0; index < projected.length; index++) {
    const turn = projected[index]
    // Chat history turns are only ever user/assistant in practice — the
    // system prompt is threaded separately, above.
    if (turn.role !== 'user' && turn.role !== 'assistant') continue
    const toolNotes = (turn.toolCalls ?? []).map(rememberToolCallForModel).join('\n\n')
    const text = toolNotes ? `${turn.content}\n\n${toolNotes}`.trim() : turn.content
    const images = turn.role === 'user' ? cloudCompatibleImages(imagesByTurn.get(index) ?? []) : []
    if (!text && images.length === 0) continue
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: chatCompletionsUserContent(text, images) })
    } else {
      messages.push({ role: 'assistant', content: text })
    }
  }
  return messages
}

function toChatCompletionTools(toolFunctions: Record<string, ToolFunction>): ChatCompletionTool[] {
  return Object.entries(toolFunctions).map(([name, fn]) => ({
    type: 'function',
    function: {
      name,
      description: fn.description,
      parameters: toolParameterSchema(fn.params)
    }
  }))
}

/**
 * Narrow, tool-free summary call used only for cloud context compaction (see
 * `boundHistoryForStatelessProvider` in `contextAssembler.ts`) — isolated from
 * normal generation: no tools, no streaming, no activity/stats recording.
 * Best-effort, matching every other provider's equivalent: `null` on any
 * failure or a degenerate (too-short) result, so the caller falls back to
 * just dropping the older turns instead of keeping a useless "summary".
 *
 * With `previousSummary`, performs a replacement-style rolling update (see
 * `foldIntoRollingSummary` in `rollingSummary.ts`): the returned text
 * REPLACES the previous summary rather than being appended to it.
 *
 * Takes an already-built `client`/`model`/`displayName` (rather than a
 * `CloudProviderSettings` lookup) so `AzureOpenAiProvider.ts` can reuse it
 * too — see `summarizeForCompactionOpenAiCompatible` below for the version
 * that resolves those from settings for the generic adapter's own configs.
 */
export async function summarizeViaChatCompletions(
  client: OpenAI,
  model: string,
  displayName: string,
  transcript: string,
  previousSummary?: string
): Promise<string | null> {
  try {
    const completion = await client.chat.completions.create(
      {
        model,
        max_tokens: MAX_COMPACTION_SUMMARY_TOKENS,
        messages: [
          {
            role: 'user',
            content: previousSummary
              ? buildCompactionUpdatePrompt(transcript, previousSummary)
              : buildCompactionSummaryPrompt(transcript)
          }
        ]
      },
      { timeout: COMPACTION_TIMEOUT_MS }
    )
    if (completion.usage) {
      // Real billed usage with no chat turn attached to it — fold into the
      // daily/model token totals so the usage gauge and daily cap comparison
      // aren't blind to compaction spend (see `recordAncillaryUsage`'s comment).
      tokenActivityStore.recordAncillaryUsage({
        inputTokens: completion.usage.prompt_tokens ?? 0,
        outputTokens: completion.usage.completion_tokens ?? 0,
        modelId: model,
        modelName: `${displayName} — ${model}`
      })
    }
    const text = completion.choices[0]?.message?.content?.trim() ?? ''
    return text.length >= MIN_SUMMARY_CHARS ? text : null
  } catch (error) {
    log.warn(`Cloud history compaction summary failed (${displayName}):`, error)
    return null
  }
}

export async function summarizeForCompactionOpenAiCompatible(
  config: OpenAiCompatibleConfig,
  transcript: string,
  previousSummary?: string,
  modelOverride?: string
): Promise<string | null> {
  const settings = readSettings(config.id)
  const apiKey = settings.apiKey.trim()
  if (!apiKey) return null

  const client = new OpenAI({ apiKey, baseURL: config.baseURL })
  const model = modelOverride?.trim() || settings.model.trim() || config.defaultModel
  return summarizeViaChatCompletions(client, model, config.displayName, transcript, previousSummary)
}

/**
 * Confirm a cloud provider API key actually works, and that `model` is
 * reachable with it. Uses `models.retrieve` — a metadata-only call, not a
 * generation — so checking a key never spends tokens, matching every other
 * provider's own verify function. Some OpenAI-compatible providers only
 * reliably implement `models.list` rather than a single-model retrieve; a
 * provider like that surfaces as a legible (not crashing) "could not verify"
 * error here rather than a false negative on a genuinely valid key — worth
 * revisiting per-provider if that turns out to be a real false-negative in
 * practice, not assumed upfront. Takes an already-built `client` so
 * `AzureOpenAiProvider.ts` can reuse it too.
 */
export async function verifyKeyViaModelsRetrieve(client: OpenAI, model: string): Promise<void> {
  try {
    await client.models.retrieve(model)
  } catch (error) {
    if (error instanceof OpenAI.AuthenticationError) {
      throw new Error('Invalid API key.')
    }
    if (error instanceof OpenAI.NotFoundError) {
      throw new Error(`Key looks valid, but model "${model}" isn't available on this account.`)
    }
    throw new Error(error instanceof Error ? error.message : 'Could not verify the API key.')
  }
}

export async function verifyOpenAiCompatibleKey(
  config: OpenAiCompatibleConfig,
  apiKey: string,
  model: string
): Promise<void> {
  const client = new OpenAI({
    apiKey,
    baseURL: config.baseURL,
    timeout: VERIFY_KEY_TIMEOUT_MS
  })
  return verifyKeyViaModelsRetrieve(client, model)
}
