import OpenAI, { APIUserAbortError } from 'openai'
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions/completions'
import type {
  ChatHistoryTurn,
  ChatImageInput,
  ContextBudgetUsage,
  GenerationStats
} from '@shared/chat.types'
import { projectHistoryForModel, rememberToolCallForModel } from './contextAssembler'
import { buildTools } from '../tools/registry'
import type { DefineChatSessionFunction, ToolFunction } from '../tools/types'
import { createLoopGuardState } from '../tools/loopGuard'
import { createReadCoverageTracker } from '../tools/readCoverage'
import { createLogger } from '../utils/logger'
import { LlamaServerRuntime } from './LlamaServerRuntime'
import { DIRECT_ANSWER_TEMPLATE_KWARGS } from './directAnswer'
import { isDroppedStreamError } from './droppedStreamError'
import { boundToolSurface, type BoundedToolSurface } from './toolSurface'
import type { GenerateOutcome, GenerateParams } from './LlamaService'
import type { ModelLoadOptions } from '@shared/model.types'
import {
  createVisualInputQueue,
  drainVisualInputs,
  isValidVisionImageInput,
  LOCAL_VISION_MIME_TYPES,
  MAX_VISION_IMAGES,
  reopenChatImage,
  type VisualInputQueue
} from '../vision/imageInputs'

const log = createLogger('llama:vision')
const DEFAULT_MAX_TOKENS = 4096
const MAX_TOOL_ROUNDS = 20
const defineToolFunction = ((fn) => fn) as DefineChatSessionFunction

interface PendingToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

/**
 * Image-aware local provider backed by Anodex's private llama-server process.
 * It reuses the exact guarded tool handlers used by node-llama-cpp and cloud
 * providers; only the inference transport changes.
 */
export class LlamaVisionService {
  private readonly runtime: LlamaServerRuntime
  private contextSize = 8192

  constructor(onUnexpectedExit?: (message: string) => void) {
    this.runtime = new LlamaServerRuntime(onUnexpectedExit)
  }

  get active(): boolean {
    return this.runtime.activeConnection !== undefined
  }

  async load(options: ModelLoadOptions): Promise<void> {
    this.contextSize = options.contextSize ?? 8192
    await this.runtime.start(options)
  }

  async unload(): Promise<void> {
    await this.runtime.stop()
  }

  countPromptTokens(prompt: string): number {
    return Math.max(1, Math.ceil(prompt.length / 4))
  }

  async generate(params: GenerateParams): Promise<GenerateOutcome> {
    const connection = this.runtime.activeConnection
    if (!connection) throw new Error('The local vision model is not loaded.')

    const client = new OpenAI({
      apiKey: connection.apiKey,
      baseURL: connection.baseUrl,
      timeout: 15 * 60_000,
      maxRetries: 0
    })
    const visualInputs = createVisualInputQueue(MAX_VISION_IMAGES, LOCAL_VISION_MIME_TYPES)
    const allToolFunctions = params.tools
      ? this.buildToolFunctions(params, visualInputs)
      : undefined
    const toolSurface = this.boundTools(allToolFunctions, params)
    const toolFunctions =
      Object.keys(toolSurface.functions).length > 0 ? toolSurface.functions : undefined
    const tools = toolFunctions ? toOpenAiTools(toolFunctions) : undefined
    const messages = await this.buildMessages(params)
    const startedAt = Date.now()
    let content = ''
    let thinking = ''
    let outputTokens = 0
    let stopped = false
    let tokenLimit = false
    let roundsExhausted = false

    const maxToolRounds = params.maxProviderRounds ?? MAX_TOOL_ROUNDS
    for (let round = 0; round < maxToolRounds; round++) {
      if (params.signal?.aborted) {
        stopped = true
        break
      }

      let roundContent = ''
      let roundThinking = ''
      let finishReason: string | null = null
      const pendingCalls = new Map<number, PendingToolCall>()
      try {
        const stream = await client.chat.completions.create(
          {
            model: connection.modelId,
            messages,
            tools,
            tool_choice: tools ? 'auto' : undefined,
            parallel_tool_calls: false,
            temperature: params.options?.temperature,
            top_p: params.options?.topP,
            max_tokens: params.options?.maxTokens ?? DEFAULT_MAX_TOKENS,
            stream: true,
            stream_options: { include_usage: true }
          },
          { signal: params.signal }
        )

        for await (const chunk of stream) {
          if (chunk.usage?.completion_tokens) outputTokens += chunk.usage.completion_tokens
          const choice = chunk.choices[0]
          if (!choice) continue
          finishReason = choice.finish_reason ?? finishReason
          const delta = choice.delta
          if (delta.content) {
            roundContent += delta.content
            content += delta.content
            params.onToken(delta.content)
          }
          const reasoning = (delta as typeof delta & { reasoning_content?: string })
            .reasoning_content
          if (reasoning) {
            roundThinking += reasoning
            thinking += reasoning
            params.onThinkingToken?.(reasoning)
          }
          for (const call of delta.tool_calls ?? []) {
            const existing = pendingCalls.get(call.index) ?? {
              index: call.index,
              id: '',
              name: '',
              arguments: ''
            }
            if (call.id) existing.id += call.id
            if (call.function?.name) existing.name += call.function.name
            if (call.function?.arguments) existing.arguments += call.function.arguments
            pendingCalls.set(call.index, existing)
          }
        }
      } catch (error) {
        if (params.signal?.aborted || error instanceof APIUserAbortError) {
          stopped = true
          break
        }
        throw await this.describeGenerationError(error)
      }

      if (outputTokens === 0) {
        outputTokens += Math.ceil((roundContent.length + roundThinking.length) / 4)
      }
      if (finishReason === 'length') tokenLimit = true

      const calls = [...pendingCalls.values()]
        .filter((call) => call.id && call.name)
        .sort((a, b) => a.index - b.index)
      if (calls.length === 0 || !toolFunctions) break
      if (round === maxToolRounds - 1) {
        roundsExhausted = true
        break
      }

      const assistantToolCalls: ChatCompletionMessageFunctionToolCall[] = calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments }
      }))
      messages.push({
        role: 'assistant',
        content: roundContent || null,
        tool_calls: assistantToolCalls
      })
      for (const call of calls) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: await runTool(toolFunctions, call)
        })
      }
      const inspectionImages = drainVisualInputs(visualInputs)
      if (inspectionImages.length > 0) {
        messages.push({
          role: 'user',
          content: userContent(
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
      tokensPerSecond: outputTokens / (durationMs / 1000)
    }
    return {
      content,
      thinking: thinking || undefined,
      stats,
      contextBudget: approximateContextBudget(params, toolSurface, this.contextSize),
      stopped: stopped || roundsExhausted || tokenLimit,
      stopReason: roundsExhausted
        ? 'rounds-exhausted'
        : stopped
          ? 'user'
          : tokenLimit
            ? 'token-limit'
            : undefined
    }
  }

  /**
   * Rewrite a raw provider/transport error into something actionable. Node's
   * `undici` surfaces a connection that dropped mid-stream as a bare
   * `TypeError: terminated` — exactly what happens when the private llama-server
   * process dies (most often an out-of-memory kill) while a reply is still
   * streaming. Give the runtime a moment to record its exit, then fold its real
   * exit code / stderr tail into the message instead of leaking `terminated`.
   */
  private async describeGenerationError(error: unknown): Promise<Error> {
    if (!isDroppedStreamError(error)) {
      return error instanceof Error ? error : new Error(String(error))
    }
    await this.runtime.settleExit()
    const reason = this.runtime.describeUnexpectedStop()
    return new Error(
      reason ??
        'The local vision model stopped unexpectedly while generating (most likely it ran out of ' +
          'memory). Reload the model, lower its context size, or choose a smaller vision model, then ' +
          'try again.'
    )
  }

  /**
   * One prompt in, one short answer out — the transport behind chat titles,
   * toast summaries, inbox digests and compaction folds.
   *
   * Every caller caps the reply at a few dozen tokens, so the request must ask
   * the model not to think; see `directAnswer.ts` for why that is not the
   * default and what it costs when it doesn't happen.
   */
  async completeText(
    prompt: string,
    options: { maxTokens: number; temperature: number; signal?: AbortSignal }
  ): Promise<string> {
    const connection = this.runtime.activeConnection
    if (!connection) throw new Error('The local vision model is not loaded.')
    const client = new OpenAI({
      apiKey: connection.apiKey,
      baseURL: connection.baseUrl,
      timeout: 5 * 60_000,
      maxRetries: 0
    })
    const body: ChatCompletionCreateParamsNonStreaming = {
      model: connection.modelId,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      stream: false
    }
    const response = await client.chat.completions.create(
      // `chat_template_kwargs` is outside the OpenAI schema — a llama.cpp
      // extension the SDK serializes through untouched. Widened here rather
      // than on the literal above so the standard fields keep their checking.
      { ...body, chat_template_kwargs: DIRECT_ANSWER_TEMPLATE_KWARGS } as typeof body & {
        chat_template_kwargs: Readonly<Record<string, unknown>>
      },
      { signal: options.signal }
    )
    const message = response.choices[0]?.message
    const reasoning = (message as (typeof message & { reasoning_content?: string }) | undefined)
      ?.reasoning_content
    return message?.content || reasoning || ''
  }

  private buildToolFunctions(
    params: GenerateParams,
    visualInputs: VisualInputQueue
  ): Record<string, ToolFunction> | undefined {
    if (!params.tools) return undefined
    return buildTools(defineToolFunction, {
      conversationId: params.conversationId,
      messageId: params.messageId,
      workspaceRoot: params.tools.workspaceRoot,
      userFiles: params.tools.userFiles,
      projectId: params.tools.projectId,
      permissionMode: params.tools.permissionMode,
      commandShell: params.tools.commandShell,
      webSearch: params.tools.webSearch,
      email: params.tools.email,
      memory: params.tools.memory,
      enabledTools: params.tools.enabledTools ?? null,
      disabledTools: params.tools.disabledTools,
      mcpTools: params.tools.mcpTools,
      evidenceFocus: params.tools.evidenceFocus,
      recordArtifact: params.tools.recordArtifact,
      webSources: params.tools.webSources,
      beforeTool: params.tools.beforeTool,
      plan: { current: params.tools.plan },
      turnGate: { approved: false },
      loopGuard: createLoopGuardState(),
      // Fresh every generation call, matching the text and cloud model paths.
      progress: { madeChange: false },
      modelResultBudget: { current: null },
      readCoverage: params.tools.readCoverage ?? createReadCoverageTracker(),
      visualInputs,
      signal: params.signal,
      emit: params.tools.onActivity,
      confirm: params.tools.confirm
    })
  }

  private boundTools(
    allFunctions: Record<string, ToolFunction> | undefined,
    params: GenerateParams
  ): BoundedToolSurface {
    return boundToolSurface({
      allFunctions,
      define: defineToolFunction,
      routingText: [...params.history.slice(-8).map((turn) => turn.content), params.prompt].join(
        '\n'
      ),
      targetFixedTokens: Math.max(1_200, Math.floor(this.contextSize * 0.28)),
      maxDirectTools: Math.max(8, Math.min(24, Math.floor(this.contextSize / 1_024) + 4)),
      measureFixedTokens: (functions) =>
        functions ? Math.ceil(JSON.stringify(toOpenAiTools(functions)).length / 4) : 0
    })
  }

  private async buildMessages(params: GenerateParams): Promise<ChatCompletionMessageParam[]> {
    const messages: ChatCompletionMessageParam[] = []
    const snapshot = params.context?.activeSnapshot?.summary?.trim()
    const system = [
      params.systemPrompt?.trim(),
      snapshot ? `Earlier conversation summary:\n${snapshot}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    if (system) messages.push({ role: 'system', content: system })

    const boundedHistory = boundHistory(projectHistoryForModel(params.history), this.contextSize)
    const currentImages = (params.images ?? [])
      .filter(isValidVisionImageInput)
      .slice(0, MAX_VISION_IMAGES)
    let remainingImages = MAX_VISION_IMAGES - currentImages.length
    for (const turn of boundedHistory) {
      if (turn.role !== 'user' && turn.role !== 'assistant') continue
      const toolNotes = (turn.toolCalls ?? []).map(rememberToolCallForModel).join('\n\n')
      const text = toolNotes ? `${turn.content}\n\n${toolNotes}`.trim() : turn.content
      if (turn.role === 'assistant') {
        if (text) messages.push({ role: 'assistant', content: text })
        continue
      }

      const images: ChatImageInput[] = []
      for (const attachment of turn.attachments ?? []) {
        if (remainingImages <= 0 || attachment.kind !== 'image') continue
        const image = await reopenChatImage(attachment)
        if (!image) continue
        images.push(image)
        remainingImages -= 1
      }
      messages.push({ role: 'user', content: userContent(text, images) })
    }

    messages.push({ role: 'user', content: userContent(params.prompt, currentImages) })
    return messages
  }
}

function toOpenAiTools(toolFunctions: Record<string, ToolFunction>): ChatCompletionTool[] {
  return Object.entries(toolFunctions).map(([name, fn]) => {
    const schema = (fn.params ?? {}) as { properties?: Record<string, unknown> }
    const properties = schema.properties ?? {}
    return {
      type: 'function',
      function: {
        name,
        description: fn.description,
        parameters: {
          type: 'object',
          properties,
          required: Object.keys(properties)
        }
      }
    }
  })
}

async function runTool(
  toolFunctions: Record<string, ToolFunction>,
  call: PendingToolCall
): Promise<string> {
  const tool = toolFunctions[call.name]
  if (!tool) return `Unknown tool "${call.name}".`
  let args: unknown
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {}
  } catch {
    return `Tool "${call.name}" received invalid JSON arguments.`
  }
  try {
    const result: unknown = await tool.handler(args)
    return typeof result === 'string' ? result : JSON.stringify(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(`Tool "${call.name}" threw:`, error)
    return message
  }
}

function userContent(
  text: string,
  images: ChatImageInput[]
): Extract<ChatCompletionMessageParam, { role: 'user' }>['content'] {
  if (images.length === 0) return text || 'Describe the attached content.'
  return [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...images.map((image) => ({
      type: 'image_url' as const,
      image_url: { url: image.dataUrl, detail: 'auto' as const }
    }))
  ]
}

function boundHistory(history: ChatHistoryTurn[], contextSize: number): ChatHistoryTurn[] {
  const maxCharacters = Math.max(4000, Math.floor(contextSize * 4 * 0.55))
  const retained: ChatHistoryTurn[] = []
  let characters = 0
  for (let index = history.length - 1; index >= 0; index--) {
    const turn = history[index]
    const cost = turn.content.length + JSON.stringify(turn.toolCalls ?? []).length
    if (retained.length > 0 && characters + cost > maxCharacters) break
    retained.unshift(turn)
    characters += cost
  }
  return retained
}

function approximateContextBudget(
  params: GenerateParams,
  toolSurface: BoundedToolSurface,
  contextSize: number
): ContextBudgetUsage {
  const toolCount = Object.keys(toolSurface.functions).length
  const systemTokens = Math.ceil((params.systemPrompt?.length ?? 0) / 4)
  const promptTokens = Math.ceil(params.prompt.length / 4)
  const toolSchemaTokens = toolCount * 140
  const fixedTokens = systemTokens + promptTokens + toolSchemaTokens
  return {
    contextSize,
    inputLimitTokens: Math.max(0, contextSize - 512),
    systemTokens,
    promptTokens,
    toolSchemaTokens,
    fixedTokens,
    reservedTokens: 512,
    requestedMaxOutputTokens: params.options?.maxTokens,
    effectiveMaxOutputTokens: params.options?.maxTokens ?? DEFAULT_MAX_TOKENS,
    activeToolCount: toolCount,
    deferredToolCount: toolSurface.deferredToolNames.length,
    toolRoutingApplied: toolSurface.routed
  }
}
