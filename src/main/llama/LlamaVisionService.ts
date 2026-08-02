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
import type { ToolCall } from '@shared/tools.types'
import { projectHistoryForModel, rememberToolCallForModel } from './contextAssembler'
import { buildTools } from '../tools/registry'
import type { DefineChatSessionFunction, ToolFunction } from '../tools/types'
import { createLoopGuardState } from '../tools/loopGuard'
import { createReadCoverageTracker } from '../tools/readCoverage'
import { createLogger } from '../utils/logger'
import { LlamaServerRuntime } from './LlamaServerRuntime'
import { resolveLocalOutputBudget } from './localOutputBudget'
import { DIRECT_ANSWER_TEMPLATE_KWARGS } from './directAnswer'
import { isDroppedStreamError } from './droppedStreamError'
import { isTruncatedToolCallError, truncatedArgumentsPreview } from './truncatedToolCallError'
import { boundToolSurface, type BoundedToolSurface } from './toolSurface'
import type { GenerateOutcome, GenerateParams } from './LlamaService'
import type { ModelInfo, ModelLoadOptions } from '@shared/model.types'
import { basename } from 'node:path'
import { modelReliabilityStore } from '../models/ModelReliabilityStore'
import {
  detectFallbackToolCall,
  looksLikeFabricatedOutcome,
  looksLikeStalledIntent,
  looksLikeToolBypass,
  looksLikeUnactedIntent,
  stripFallbackCall
} from './toolCallFallback'
import {
  INTENT_NUDGE_PROMPT,
  STALLED_INTENT_NUDGE_PROMPT,
  TOOL_BYPASS_NUDGE_PROMPT
} from './intentNudges'
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
/** Headroom kept clear of the context limit, mirroring the text path's reserve. */
const RESERVED_TOKENS = 512
/**
 * How many times one turn may recover from a tool call that was cut off before
 * its arguments finished.
 *
 * Kept low on purpose. On a large local model a single long call can take many
 * minutes, so an over-generous retry budget turns one slow failure into a much
 * longer one; the guidance sent with each retry asks for a smaller call, so if
 * two attempts both overrun, the shape of the request is the problem and more
 * attempts will not fix it.
 */
const MAX_TOOL_CALL_RECOVERIES = 2
/**
 * Cap on rounds recovered by parsing a tool call the model wrote as prose.
 * Same value and same reasoning as the text path's `MAX_FALLBACK_ROUNDS`.
 */
const MAX_FALLBACK_ROUNDS = 8
/** Tools the bypass nudge names by name; it only fires when one is registered. */
const EDIT_TOOL_NAMES = ['write_file', 'edit_file', 'patch_file']

function hasEditTool(toolFunctions: Record<string, ToolFunction>): boolean {
  return EDIT_TOOL_NAMES.some((name) => name in toolFunctions)
}
const defineToolFunction = ((fn) => fn) as DefineChatSessionFunction

interface PendingToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

/**
 * What this turn's input actually costs, measured with the model's own
 * tokenizer through llama-server's `/tokenize`.
 *
 * Every field is a real count or the whole object is absent — see
 * `LlamaServerRuntime.countTokens` for why a partial/estimated measurement is
 * worse than none here. Note two deliberate differences from the text path's
 * `measureContextBudget`:
 *
 * - `systemTokens` covers the system message *and* replayed history. This
 *   transport re-sends the entire conversation every round (there is no
 *   KV-cache session to inherit it), so history is genuinely fixed input for
 *   the turn rather than something a context-shift strategy can evict.
 * - Image tokens are not included: `/tokenize` only accepts text, and a
 *   projector's embedding cost isn't expressible there. This under-counts a
 *   turn carrying images, which errs toward a *larger* output allowance —
 *   the safe direction, since an over-tight clamp is what truncates a reply
 *   mid-tool-call.
 */
interface MeasuredInput {
  systemTokens: number
  promptTokens: number
  toolSchemaTokens: number
  fixedTokens: number
}

/**
 * Image-aware local provider backed by Anodex's private llama-server process.
 * It reuses the exact guarded tool handlers used by node-llama-cpp and cloud
 * providers; only the inference transport changes.
 */
export class LlamaVisionService {
  private readonly runtime: LlamaServerRuntime
  private contextSize = 8192

  /**
   * @param getCurrentModel Which model is loaded, for reliability recording.
   *   Supplied by `LlamaService`, which owns that state. Without it this
   *   transport contributed nothing to `ModelReliabilityStore` — so every
   *   multimodal model scored as if it had never called a tool at all.
   */
  constructor(
    onUnexpectedExit?: (message: string) => void,
    private readonly getCurrentModel?: () => ModelInfo | undefined
  ) {
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
    // Mirrors the text path's per-turn tracking (see `LlamaService.
    // generateInternal`): `hadSuccessfulWrite` gates the unacted-intent check,
    // the broader `hadAnyToolAttempt` gates the fabricated-outcome one, so a
    // truthful same-turn report is never flagged.
    const currentModel = this.getCurrentModel?.()
    let hadSuccessfulWrite = false
    let hadAnyToolAttempt = false
    let fabricationDetectedThisTurn = false
    const allToolFunctions = params.tools
      ? this.buildToolFunctions(params, visualInputs, (call) => {
          hadAnyToolAttempt = true
          if (call.kind === 'write' && call.status === 'success') hadSuccessfulWrite = true
          // Denied calls are excluded — a user decision, not a model signal.
          if (currentModel && (call.status === 'success' || call.status === 'error')) {
            modelReliabilityStore.recordToolCall(
              currentModel.id,
              currentModel.name,
              call.name,
              call.status,
              basename(currentModel.path)
            )
          }
          params.tools?.onActivity(call)
        })
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
    /** Set when the recovery budget for cut-off tool calls ran out. */
    let toolCallsTruncated = false

    const maxToolRounds = params.maxProviderRounds ?? MAX_TOOL_ROUNDS
    const requestedMaxTokens = params.options?.maxTokens
    let measured: MeasuredInput | null = null
    let effectiveMaxTokens = requestedMaxTokens ?? DEFAULT_MAX_TOKENS
    let toolCallRecoveries = 0
    let fallbackRounds = 0
    let usedIntentNudge = false
    for (let round = 0; round < maxToolRounds; round++) {
      if (params.signal?.aborted) {
        stopped = true
        break
      }

      // Sized against what this round's prompt actually leaves room for. When
      // the runtime can't tokenize, `measured` stays null and the configured
      // ceiling is used unchanged — the pre-measurement behavior — because
      // clamping against a guess truncates replies for no benefit.
      measured = await this.measureInput(messages, tools, params.prompt)
      if (measured) {
        const budget = resolveLocalOutputBudget({
          contextSize: this.contextSize,
          inputLimitTokens: Math.max(0, this.contextSize - RESERVED_TOKENS),
          fixedTokens: measured.fixedTokens,
          requestedMaxTokens,
          hasFunctions: toolFunctions != null
        })
        effectiveMaxTokens = budget.effectiveMaxTokens
        if (
          budget.requestedMaxTokens !== undefined &&
          budget.requestedMaxTokens > budget.effectiveMaxTokens
        ) {
          log.info('Clamped local vision output budget to measured context capacity', {
            round,
            requestedMaxTokens: budget.requestedMaxTokens,
            effectiveMaxTokens: budget.effectiveMaxTokens,
            fixedTokens: measured.fixedTokens
          })
        }
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
            max_tokens: effectiveMaxTokens,
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
        // The model was cut off part-way through emitting a tool call, so
        // llama-server's own parse of the arguments failed and took the whole
        // request with it. The partial arguments are deliberately NOT repaired
        // and run — see `truncatedArgumentsPreview` — but the turn is still
        // recoverable: tell the model what happened and let it try again in a
        // shape that fits.
        if (isTruncatedToolCallError(error) && toolFunctions) {
          if (toolCallRecoveries >= MAX_TOOL_CALL_RECOVERIES) {
            toolCallsTruncated = true
            log.warn('Giving up after repeated truncated tool calls', {
              recoveries: toolCallRecoveries
            })
            break
          }
          toolCallRecoveries += 1
          const preview = truncatedArgumentsPreview(error)
          log.warn('Recovering from a truncated tool call', {
            attempt: toolCallRecoveries,
            preview
          })
          messages.push({ role: 'user', content: truncatedToolCallGuidance(preview) })
          continue
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

      if (calls.length === 0 && toolFunctions) {
        // Native function-calling produced nothing. Two recoveries, in the
        // same order and on the same terms as the text path: first look for a
        // real call the model wrote as prose, then — failing that — check
        // whether it narrated work it never did.
        const fallback =
          fallbackRounds < MAX_FALLBACK_ROUNDS
            ? detectFallbackToolCall(roundContent, new Set(Object.keys(toolFunctions)))
            : null
        if (fallback) {
          fallbackRounds += 1
          hadAnyToolAttempt = true
          // Drop the raw call text from the visible reply; the tool card
          // stands in for it. `content` is rewound by exactly this round's
          // contribution so earlier rounds are untouched.
          const stripped = stripFallbackCall(roundContent, fallback)
          content = content.slice(0, content.length - roundContent.length) + stripped
          const id = `fallback_${round}`
          messages.push({
            role: 'assistant',
            content: stripped || null,
            tool_calls: [
              {
                id,
                type: 'function',
                function: { name: fallback.name, arguments: JSON.stringify(fallback.arguments) }
              }
            ]
          })
          messages.push({
            role: 'tool',
            tool_call_id: id,
            content: await runTool(toolFunctions, {
              index: 0,
              id,
              name: fallback.name,
              arguments: JSON.stringify(fallback.arguments)
            })
          })
          continue
        }

        const isToolBypass = !hadSuccessfulWrite && looksLikeToolBypass(roundContent, params.prompt)
        const isStalledIntent =
          !hadAnyToolAttempt && looksLikeStalledIntent(roundContent, params.prompt)
        const needsUnactedIntentNudge =
          (!hadSuccessfulWrite && looksLikeUnactedIntent(roundContent)) ||
          (!hadAnyToolAttempt && looksLikeFabricatedOutcome(roundContent))
        // Recorded whether or not a nudge fires below: the model still
        // fabricated, even on a round with no retry budget left.
        if (isToolBypass || isStalledIntent || needsUnactedIntentNudge) {
          fabricationDetectedThisTurn = true
          if (currentModel) {
            modelReliabilityStore.recordFabrication(
              currentModel.id,
              currentModel.name,
              basename(currentModel.path)
            )
          }
        }
        // The bypass nudge names write_file/edit_file/patch_file, so it only
        // fires when one of them is actually registered.
        const needsToolBypassNudge = isToolBypass && hasEditTool(toolFunctions)
        if (
          (needsToolBypassNudge || needsUnactedIntentNudge || isStalledIntent) &&
          !usedIntentNudge
        ) {
          usedIntentNudge = true
          // Only when there is something to attribute: an assistant turn with
          // neither content nor tool calls is not a shape every chat template
          // renders safely.
          if (roundContent) messages.push({ role: 'assistant', content: roundContent })
          messages.push({
            role: 'user',
            content: needsToolBypassNudge
              ? TOOL_BYPASS_NUDGE_PROMPT
              : needsUnactedIntentNudge
                ? INTENT_NUDGE_PROMPT
                : STALLED_INTENT_NUDGE_PROMPT
          })
          continue
        }
      }

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
      // Marked here as well as in the activity callback. A tool that returns
      // without emitting (or one whose emit is filtered) would otherwise leave
      // this false and let the fabrication check fire on a turn that really
      // did call something — a false flag that would go on to mis-rank the
      // model in `ModelReliabilityStore`.
      hadAnyToolAttempt = true
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
      contextBudget: contextBudgetFor({
        measured,
        params,
        toolSurface,
        contextSize: this.contextSize,
        requestedMaxTokens,
        effectiveMaxTokens
      }),
      fabricationDetected: fabricationDetectedThisTurn || undefined,
      stopped: stopped || roundsExhausted || tokenLimit || toolCallsTruncated,
      stopReason: toolCallsTruncated
        ? 'tool-call-truncated'
        : roundsExhausted
          ? 'rounds-exhausted'
          : stopped
            ? 'user'
            : tokenLimit
              ? 'token-limit'
              : undefined
    }
  }

  /**
   * Measure this round's real input cost, or return `null` if any part of it
   * could not be measured. Callers must treat `null` as "don't clamp" rather
   * than substituting an estimate.
   *
   * Re-measured every round on purpose: tool results are appended to
   * `messages` as the turn proceeds, so a budget computed once before the loop
   * grows steadily more wrong exactly as the remaining room shrinks.
   */
  private async measureInput(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[] | undefined,
    prompt: string
  ): Promise<MeasuredInput | null> {
    const conversationText = messages.map(messageText).filter(Boolean).join('\n')
    const [conversationTokens, promptTokens, toolSchemaTokens] = await Promise.all([
      this.runtime.countTokens(conversationText),
      this.runtime.countTokens(prompt),
      tools ? this.runtime.countTokens(JSON.stringify(tools)) : Promise.resolve(0)
    ])
    if (conversationTokens === null || promptTokens === null || toolSchemaTokens === null) {
      return null
    }
    // `messages` already ends with the current prompt, so subtract it back out
    // to keep `promptTokens` an incremental figure and `fixedTokens` a total.
    const systemTokens = Math.max(0, conversationTokens - promptTokens)
    return {
      systemTokens,
      promptTokens,
      toolSchemaTokens,
      fixedTokens: systemTokens + promptTokens + toolSchemaTokens
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
    // Reached only when recovery was impossible (no tools registered for this
    // turn) — the round loop handles the recoverable case. Never surface the
    // raw nlohmann text: it is several kilobytes of C++ parser output that
    // gets persisted verbatim into the conversation.
    if (isTruncatedToolCallError(error)) {
      log.error('Tool call truncated with no tools registered to retry against', {
        preview: truncatedArgumentsPreview(error),
        runtimeOutput: this.runtime.recentOutput()
      })
      return new Error(
        'The model was cut off part-way through a tool call, so it could not be run and nothing ' +
          'was changed. Ask for the work in smaller pieces, or raise the model’s context size.'
      )
    }
    if (!isDroppedStreamError(error)) {
      // Whatever this is, llama-server's own output is the best record of it
      // and is otherwise thrown away. Logged rather than returned: it can
      // contain rendered prompt text.
      const runtimeOutput = this.runtime.recentOutput()
      if (runtimeOutput) log.error('llama-server output around the failure:', runtimeOutput)
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
    visualInputs: VisualInputQueue,
    onActivity: (call: ToolCall) => void
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
      emit: onActivity,
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

/**
 * Corrective prompt for a tool call that never finished emitting.
 *
 * Says what happened, and — critically — asks for a *different* shape rather
 * than a repeat. A verbatim retry of a call that already overran reproduces
 * the same failure at the same cost, which on a slow local model means many
 * more minutes for the same outcome.
 */
function truncatedToolCallGuidance(preview: string | undefined): string {
  return [
    'Your previous tool call was cut off before its arguments were complete, so it could not be run',
    preview ? ` (it ended at: ${preview}).` : '.',
    ' Nothing was written and nothing changed.',
    ' Do not repeat that call as-is. If you were writing a long file, split the work:',
    ' create it with a small first write_file call, then extend it with follow-up edits,',
    ' keeping every single call short. Otherwise, answer without the tool call.'
  ].join('')
}

function toOpenAiTools(toolFunctions: Record<string, ToolFunction>): ChatCompletionTool[] {
  return Object.entries(toolFunctions).map(([name, fn]) => {
    const schema = (fn.params ?? {}) as {
      properties?: Record<string, unknown>
      required?: readonly string[]
    }
    const properties = schema.properties ?? {}
    // Each tool declares its own `required` list; honor it. Marking every
    // property required (as this did) turns optional arguments into mandatory
    // ones, which pushes a model into inventing values for parameters it
    // should simply have omitted.
    const required = schema.required ?? []
    return {
      type: 'function',
      function: {
        name,
        description: fn.description,
        parameters: {
          type: 'object',
          properties,
          required: required.filter((key) => key in properties)
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

/**
 * The turn's context accounting, built from real measurements when the runtime
 * could supply them and from a coarse character estimate when it could not.
 *
 * The estimate is retained only so the context meter still renders something
 * on a runtime without `/tokenize`; nothing sizes a generation from it. See
 * `MeasuredInput` for what the measured fields mean on this transport.
 */
function contextBudgetFor(input: {
  measured: MeasuredInput | null
  params: GenerateParams
  toolSurface: BoundedToolSurface
  contextSize: number
  requestedMaxTokens: number | undefined
  effectiveMaxTokens: number
}): ContextBudgetUsage {
  const { measured, params, toolSurface, contextSize } = input
  const toolCount = Object.keys(toolSurface.functions).length
  const counts = measured ?? estimatedInput(params, toolCount)
  return {
    contextSize,
    inputLimitTokens: Math.max(0, contextSize - RESERVED_TOKENS),
    systemTokens: counts.systemTokens,
    promptTokens: counts.promptTokens,
    toolSchemaTokens: counts.toolSchemaTokens,
    fixedTokens: counts.fixedTokens,
    reservedTokens: RESERVED_TOKENS,
    requestedMaxOutputTokens: input.requestedMaxTokens,
    effectiveMaxOutputTokens: input.effectiveMaxTokens,
    activeToolCount: toolCount,
    deferredToolCount: toolSurface.deferredToolNames.length,
    toolRoutingApplied: toolSurface.routed
  }
}

function estimatedInput(params: GenerateParams, toolCount: number): MeasuredInput {
  const systemTokens = Math.ceil((params.systemPrompt?.length ?? 0) / 4)
  const promptTokens = Math.ceil(params.prompt.length / 4)
  const toolSchemaTokens = toolCount * 140
  return {
    systemTokens,
    promptTokens,
    toolSchemaTokens,
    fixedTokens: systemTokens + promptTokens + toolSchemaTokens
  }
}

/**
 * Text carried by one rendered message, for tokenization. Image parts are
 * skipped — see `MeasuredInput` for why that under-count is the safe direction.
 */
function messageText(message: ChatCompletionMessageParam): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      typeof part === 'object' && part && 'text' in part
        ? String((part as { text: unknown }).text)
        : ''
    )
    .join('')
}
