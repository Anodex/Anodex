import { EventEmitter } from 'node:events'
import { freemem } from 'node:os'
import { basename } from 'node:path'
import type {
  Llama,
  LlamaModel,
  LlamaContext,
  LlamaContextSequence,
  LlamaChatSession,
  ChatHistoryItem,
  ChatModelFunctionCall,
  LlamaChatResponseChunk
} from 'node-llama-cpp'
import type {
  EngineState,
  ModelInfo,
  ModelLoadOptions,
  ModelSettingsRecommendation
} from '@shared/model.types'
import type { ChatHistoryTurn, GenerationOptions, GenerationStats } from '@shared/chat.types'
import type { PermissionMode, WebSearchSettings } from '@shared/settings.types'
import type { ToolCall, ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import type { Plan } from '@shared/plan.types'
import { CONTEXT_SIZE_LADDER } from '@shared/contextSizes'
import { pickRecommendedContextSize } from '@shared/contextRecommendation'
import type { ToolFunction } from '../tools/types'
import { buildTools } from '../tools/registry'
import {
  detectFallbackToolCall,
  looksLikeFabricatedOutcome,
  looksLikeUnactedIntent,
  stripFallbackCall,
  type FallbackToolCall
} from './toolCallFallback'
import { modelReliabilityStore } from '../models/ModelReliabilityStore'
import { createLogger } from '../utils/logger'

const log = createLogger('llama')

/**
 * Cap on manual tool-call recovery rounds within a single generation (see
 * `toolCallFallback.ts`). Bounds how many times we can re-prompt after
 * executing a fallback-detected call, so a model stuck repeating the same
 * malformed call can't loop forever. Verified live that 4 was too tight for a
 * realistic "diagnose via a real error, then retry" sequence: list_directory,
 * search_files, a wrong first write_file, and run_command each consumed one
 * round, exhausting the budget right as the model was about to attempt the
 * *correct* write_file informed by the real error it had just seen.
 */
const MAX_FALLBACK_ROUNDS = 8

/**
 * Sent once, at most, when a reply describes an outcome — a file change, an
 * approval, a denial, a passing test — that didn't actually happen this turn
 * (see `looksLikeUnactedIntent`/`looksLikeFabricatedOutcome` in
 * `toolCallFallback.ts`). Covers both a false first-person completion claim
 * (verified directly: qwen2.5-coder-7b described new file content in a code
 * block without ever calling a tool) and a fabricated third-person outcome
 * (verified directly: the same model later invented "The user denied adding
 * the function" in a turn with zero tool calls). One retry only; if it
 * narrates again, that's treated as the model's real answer rather than
 * looped on indefinitely.
 */
const INTENT_NUDGE_PROMPT =
  'You described an outcome — a change, an approval, or a denial — that did not ' +
  'actually happen this turn; no tool was called. If you intend to make the change, ' +
  "call write_file or edit_file now with the exact content. If you can't or the task " +
  "is blocked, say so plainly instead of describing something that didn't happen."

/** The dynamically-imported `node-llama-cpp` module (ESM-only). */
type LlamaModule = typeof import('node-llama-cpp')

export interface GenerateParams {
  conversationId: string
  /** Assistant message id, used to route tool activity to the right turn. */
  messageId: string
  systemPrompt?: string
  history: ChatHistoryTurn[]
  prompt: string
  options?: GenerationOptions
  /** Called for each decoded text chunk as it is produced. */
  onToken: (token: string) => void
  signal?: AbortSignal
  /** When present, the model is given tools for this generation. */
  tools?: {
    /** Workspace folder for file/command tools, or null for web-only tools. */
    workspaceRoot: string | null
    /** Id of the active project, or null in a general (non-project) chat. */
    projectId: string | null
    permissionMode: PermissionMode
    webSearch: WebSearchSettings
    /** The conversation's current plan, if any, so plan tools can continue it across turns. */
    plan: Plan | null
    onActivity: (call: ToolCall) => void
    confirm: (request: ToolConfirmRequest) => Promise<ToolConfirmResponse>
  }
}

export interface GenerateOutcome {
  content: string
  stats: GenerationStats
  stopped: boolean
}

/**
 * Owns the entire local Llama lifecycle: engine init, model load/unload, chat
 * sessions, and streaming generation. Exactly one model is loaded at a time.
 *
 * The heavy, ESM-only `node-llama-cpp` package is imported lazily via dynamic
 * `import()` so the main process starts fast and stays CJS-compatible.
 *
 * Consumers subscribe to the `'state'` event to receive {@link EngineState}
 * snapshots; the IPC layer forwards these to the renderer.
 */
class LlamaService extends EventEmitter {
  private modulePromise: Promise<LlamaModule> | null = null
  private llama?: Llama
  private model?: LlamaModel
  private context?: LlamaContext
  private contextSequence?: LlamaContextSequence
  private session?: LlamaChatSession
  private activeConversationId?: string

  private status: EngineState['status'] = 'unloaded'
  private currentModel?: ModelInfo
  private contextSize?: number
  private gpuLayersUsed?: number
  private gpuLayersTotal?: number
  private error?: string
  private generating = false
  /**
   * Small, separate context/sequence dedicated to `summarizeForToast()`.
   * Deliberately independent of `this.context`/`this.contextSequence` (the
   * active conversation's session) — reusing that one for a one-off "give me
   * an 8-word summary" request would rebuild its session under a fake
   * conversation id, destroying the real conversation's KV cache and forcing
   * a full, slow history replay on the user's very next message.
   */
  private summaryContext?: LlamaContext
  private summarySequence?: LlamaContextSequence
  /**
   * Guards against two concurrent `loadModel()` calls racing to allocate the
   * same GPU/model resources — observed directly as the actual cause of the
   * intermittent native startup crash (a renderer-side bug briefly caused
   * `loadModel()` to be invoked twice for the same auto-restored model; see
   * `useAnodexBridge.ts`). Kept here too, not just fixed at the source, so
   * *any* future duplicate call — from anywhere — fails loudly and safely
   * instead of racing the native engine.
   */
  private loadingModel = false

  getState(): EngineState {
    return {
      status: this.status,
      model: this.currentModel,
      contextSize: this.contextSize,
      gpuLayersUsed: this.gpuLayersUsed,
      gpuLayersTotal: this.gpuLayersTotal,
      error: this.error,
      generating: this.generating,
      contextTokensUsed: this.contextSequence?.nextTokenIndex,
      contextTokensConversationId: this.activeConversationId
    }
  }

  /** Load a model into the engine, replacing any currently loaded one. */
  async loadModel(options: ModelLoadOptions, info: ModelInfo): Promise<EngineState> {
    if (this.loadingModel) {
      throw new Error('Another model is already loading. Wait for it to finish first.')
    }
    this.loadingModel = true

    try {
      const requestedSize = options.contextSize ?? 16384
      const nlc = await this.getModule()
      const memoryIssue = await describeInsufficientMemory(info, requestedSize, nlc)
      if (memoryIssue) {
        log.warn('Refusing to load model:', memoryIssue)
        this.setState({ status: 'error', model: info, error: memoryIssue })
        throw new Error(memoryIssue)
      }

      await this.unload()
      this.setState({ status: 'loading', model: info, error: undefined })
      log.info('Loading model', info.name)

      try {
        this.llama ??= await nlc.getLlama()
        this.model = await this.llama.loadModel({
          modelPath: options.path,
          gpuLayers: options.gpuLayers === 'auto' ? undefined : options.gpuLayers
        })
        this.gpuLayersUsed = this.model.gpuLayers
        this.gpuLayersTotal = this.model.fileInsights.totalLayers
        this.context = await this.model.createContext({
          contextSize: requestedSize
        })
        this.contextSequence = this.context.getSequence()
        this.contextSize = this.context.contextSize
        if (this.contextSize < requestedSize) {
          log.warn(
            `Context silently shrunk from ${requestedSize} to ${this.contextSize}. ` +
              'Retrying with ignoreMemorySafetyChecks to enforce the requested size.'
          )
          try {
            try {
              this.contextSequence?.dispose()
              await this.context?.dispose()
            } catch {
              log.warn('Failed to dispose old context during resize')
            }
            this.context = await this.model.createContext({
              contextSize: requestedSize,
              ignoreMemorySafetyChecks: true,
              flashAttention: false
            })
            this.contextSequence = this.context.getSequence()
            this.contextSize = this.context.contextSize
            log.info('Forced context to', this.contextSize)
          } catch (oomError) {
            log.warn(
              `Could not force context size ${requestedSize}:`,
              oomError instanceof Error ? oomError.message : String(oomError)
            )
            // Fall back to the original smaller context
            this.context = await this.model.createContext({
              contextSize: this.contextSize
            })
            this.contextSequence = this.context.getSequence()
          }
        }
        this.setState({ status: 'ready', error: undefined })
        log.info('Model ready:', info.name, `(ctx ${this.contextSize})`)
        return this.getState()
      } catch (error) {
        const message = describeLoadError(error, info)
        log.error('Failed to load model:', message)
        await this.disposeModel()
        this.setState({ status: 'error', model: info, error: message })
        throw new Error(message)
      }
    } finally {
      this.loadingModel = false
    }
  }

  /** Unload the current model and free all associated resources. */
  async unload(): Promise<EngineState> {
    await this.disposeModel()
    this.setState({ status: 'unloaded', model: undefined, error: undefined })
    return this.getState()
  }

  /** Generate an assistant reply, streaming decoded tokens via `onToken`. */
  async generate(params: GenerateParams): Promise<GenerateOutcome> {
    if (this.status !== 'ready' || !this.context) {
      throw new Error('No model is loaded. Load a model from the Models tab first.')
    }
    if (this.generating) {
      throw new Error('A response is already being generated.')
    }

    const session = await this.ensureSession(
      params.conversationId,
      params.systemPrompt,
      params.history
    )

    this.generating = true
    this.emitState()

    let hadSuccessfulWrite = false
    // Any tool activity at all this turn (attempted, denied, errored, or
    // succeeded) — narrower than `hadSuccessfulWrite`, used to gate the
    // fabricated-outcome check below, which must not fire when a real
    // interaction actually happened this turn.
    let hadAnyToolAttempt = false
    const currentModel = this.currentModel
    const functions = await this.buildToolFunctions(params, (call) => {
      hadAnyToolAttempt = true
      if (call.kind === 'write' && call.status === 'success') hadSuccessfulWrite = true
      // Denied calls are excluded — that's a user decision, not a signal
      // about the model's own reliability.
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
    const startedAt = Date.now()
    let visibleContent = ''
    let tokenCount = 0
    let stopped = false
    let usedIntentNudge = false
    let prompt = params.prompt

    try {
      for (let round = 0; ; round++) {
        let roundContent = ''
        let roundSegment = ''
        const meta = await session.promptWithMeta(prompt, {
          temperature: params.options?.temperature,
          topP: params.options?.topP,
          maxTokens: params.options?.maxTokens,
          signal: params.signal,
          functions,
          // Full per-parameter JSON schema docs. Costs more prompt tokens, but
          // omitting them (as this used to) left weaker local models guessing at
          // argument names — observed directly: a 3B model repeatedly attempted
          // `edit_file` without a `path` argument once it stopped seeing the schema.
          documentFunctionParams: functions != null ? true : undefined,
          onResponseChunk: (chunk: LlamaChatResponseChunk) => {
            tokenCount += chunk.tokens.length
            if (chunk.type === 'segment') {
              roundSegment += chunk.text
              return
            }
            roundContent += chunk.text
            params.onToken(chunk.text)
          }
        })

        // Prefer the assembled final text, then fall back to streamed text.
        roundContent = meta.responseText || roundContent
        // Some reasoning/think-tagged models emit only thought segments with no
        // visible answer. Surface those instead of an empty bubble.
        if (!roundContent.trim() && roundSegment.trim()) {
          roundContent = roundSegment.trim()
        }

        log.debug('Generation round complete', {
          round,
          wrapper: session.chatWrapper?.constructor?.name,
          stopReason: meta.stopReason,
          responseTextLength: meta.responseText.length,
          segmentContentLength: roundSegment.length,
          tokenCount
        })

        if (meta.stopReason === 'abort') {
          visibleContent = appendContent(visibleContent, roundContent)
          stopped = true
          break
        }

        // Some local models fail to trigger node-llama-cpp's native function
        // calling and instead print the call as plain, unexecuted text (see
        // toolCallFallback.ts). Detect and run it manually so the turn still
        // does real work instead of silently doing nothing.
        const activeFunctions = functions
        const fallback =
          activeFunctions && round < MAX_FALLBACK_ROUNDS
            ? detectFallbackToolCall(roundContent, new Set(Object.keys(activeFunctions)))
            : null

        if (!fallback || !activeFunctions) {
          visibleContent = appendContent(visibleContent, roundContent)

          // The reply describes an outcome that didn't actually happen this turn:
          // either a claimed file change with no successful write anywhere this
          // turn, or a fabricated approval/denial/test-result when no tool was
          // called at all this turn.
          const isFabricatedOutcome =
            Boolean(activeFunctions) &&
            ((!hadSuccessfulWrite && looksLikeUnactedIntent(roundContent)) ||
              (!hadAnyToolAttempt && looksLikeFabricatedOutcome(roundContent)))

          // Record this independently of whether a nudge fires below — the
          // model still fabricated an outcome even on a round where the
          // one-nudge-per-turn budget was already spent.
          if (isFabricatedOutcome && currentModel) {
            modelReliabilityStore.recordFabrication(
              currentModel.id,
              currentModel.name,
              basename(currentModel.path)
            )
          }

          // Give it one chance to actually act.
          if (isFabricatedOutcome && !usedIntentNudge) {
            usedIntentNudge = true
            prompt = INTENT_NUDGE_PROMPT
            continue
          }
          break
        }

        // Keep any natural-language commentary the model wrote before the call
        // ("I'll check the file first...") and drop the raw call text itself —
        // the resulting tool card stands in for it in the UI.
        visibleContent = appendContent(visibleContent, stripFallbackCall(roundContent, fallback))

        const resultText = await runFallbackToolCall(activeFunctions, fallback)
        prompt = `Tool result for ${fallback.name}:\n${resultText}\n\nContinue the task using this result. If the task is complete, summarize what you did instead of calling another tool.`

        if (params.signal?.aborted) {
          stopped = true
          break
        }
      }

      return {
        content: visibleContent,
        stats: buildStats(tokenCount, startedAt),
        stopped
      }
    } catch (error) {
      if (params.signal?.aborted) {
        log.info('Generation stopped by user')
        return { content: visibleContent, stats: buildStats(tokenCount, startedAt), stopped: true }
      }
      throw error
    } finally {
      this.generating = false
      this.emitState()
    }
  }

  /**
   * A very short (~`maxWords`-word) summary of `text`, for a desktop toast's
   * title. Runs on `summaryContext`/`summarySequence` — never the active
   * conversation's own context — via a throwaway `LlamaChatSession` (for
   * proper chat-template formatting, rather than a raw completion the model
   * wasn't fine-tuned to follow as an instruction) that's disposed again
   * right after. Best-effort: returns `null` on any failure instead of
   * throwing, since the caller always has a safe static fallback string.
   */
  async summarizeForToast(text: string, maxWords: number): Promise<string | null> {
    if (this.status !== 'ready' || !this.model) return null

    try {
      this.summaryContext ??= await this.model.createContext({ contextSize: 1024 })
      this.summarySequence ??= this.summaryContext.getSequence()
      await this.summarySequence.clearHistory()

      const nlc = await this.getModule()
      let session = new nlc.LlamaChatSession({ contextSequence: this.summarySequence })
      // Qwen 3's chat template defaults to "thinking" mode — for a one-line
      // toast title we don't want a reasoning monologue, just the answer, so
      // explicitly discourage it when that's the resolved wrapper. Verified
      // directly: without this, `session.prompt()` returned an empty string
      // because the whole reply went into the (unsurfaced) thinking segment.
      if (session.chatWrapper instanceof nlc.QwenChatWrapper) {
        session.dispose()
        session = new nlc.LlamaChatSession({
          contextSequence: this.summarySequence,
          chatWrapper: new nlc.QwenChatWrapper({ thoughts: 'discourage' })
        })
      }
      try {
        const truncated = text.length > 1200 ? `${text.slice(0, 1200)}…` : text
        let responseText = ''
        let segmentText = ''
        const meta = await session.promptWithMeta(
          `Summarize the following in ${maxWords} words or fewer. Reply with only the ` +
            `summary itself — no quotes, no trailing punctuation, no preamble.\n\n${truncated}`,
          {
            // Generous relative to the target word count — leaves room for a
            // model that still reasons a little before answering, without
            // letting it ramble on at length for what's just a toast title.
            maxTokens: Math.max(64, maxWords * 4),
            temperature: 0.2,
            onResponseChunk: (chunk) => {
              if (chunk.type === 'segment') segmentText += chunk.text
              else responseText += chunk.text
            }
          }
        )
        const finalText = meta.responseText || responseText || segmentText
        return cleanToastSummary(finalText, maxWords)
      } finally {
        session.dispose()
      }
    } catch (error) {
      log.warn('Toast summary generation failed:', error)
      return null
    }
  }

  /**
   * Return a chat session bound to `conversationId`. When the conversation
   * changes, the session is rebuilt and the prior turns are replayed so context
   * is preserved. Staying on the same conversation reuses the session (and its
   * KV cache) across turns.
   */
  private async ensureSession(
    conversationId: string,
    systemPrompt: string | undefined,
    history: ChatHistoryTurn[]
  ): Promise<LlamaChatSession> {
    if (this.session && this.activeConversationId === conversationId) {
      return this.session
    }
    if (!this.context || !this.contextSequence) throw new Error('No model loaded.')

    this.disposeSession()
    try {
      await this.contextSequence.clearHistory()
    } catch (error) {
      log.warn('Failed to clear context sequence history:', error)
    }
    const nlc = await this.getModule()
    this.session = new nlc.LlamaChatSession({
      contextSequence: this.contextSequence,
      systemPrompt
    })

    const trimmed = this.truncateHistory(history)
    const items = buildHistoryItems(systemPrompt, trimmed)
    if (items.length > 0) this.session.setChatHistory(items)

    this.activeConversationId = conversationId
    return this.session
  }

  /**
   * Trim old conversation turns so the total estimated prompt fits within the
   * context window. Newest turns are kept; older ones are dropped when there
   * isn't enough room for everything.
   */
  private truncateHistory(history: ChatHistoryTurn[]): ChatHistoryTurn[] {
    if (history.length <= 1 || !this.contextSize) return history

    const charsPerToken = 3.5
    // Reserve 60% of the context for: system prompt, tool definitions, the new
    // user prompt, and the model's response. The remaining 40% is the history
    // replay budget.
    const maxHistoryChars = this.contextSize * charsPerToken * 0.4

    let total = 0
    const keep: number[] = []
    for (let i = history.length - 1; i >= 0; i--) {
      const turn = history[i]
      let cost = turn.content.length
      for (const call of turn.toolCalls ?? []) {
        cost += (call.result ?? call.detail ?? '').length
      }
      if (total + cost > maxHistoryChars && keep.length > 0) break
      total += cost
      keep.unshift(i)
    }

    const trimmed = keep.map((i) => history[i])
    if (trimmed.length < history.length) {
      log.debug(
        `Truncated history from ${history.length} to ${trimmed.length} turns (est. ${total} chars)`
      )
    }
    return trimmed
  }

  /** Build the workspace tool set for a generation, or `undefined` if disabled. */
  private async buildToolFunctions(
    params: GenerateParams,
    onActivity: (call: ToolCall) => void
  ): Promise<Record<string, ToolFunction> | undefined> {
    if (!params.tools) return undefined
    const nlc = await this.getModule()
    return buildTools(nlc.defineChatSessionFunction, {
      conversationId: params.conversationId,
      messageId: params.messageId,
      workspaceRoot: params.tools.workspaceRoot,
      projectId: params.tools.projectId,
      permissionMode: params.tools.permissionMode,
      webSearch: params.tools.webSearch,
      // A mutable box, not the plan value itself — shared by every tool call
      // in this generation so `update_plan_step` sees `write_plan`'s result
      // within the same turn (see `ToolRuntimeContext.plan`'s doc comment).
      plan: { current: params.tools.plan },
      signal: params.signal,
      emit: onActivity,
      confirm: params.tools.confirm
    })
  }

  /**
   * Probe the host's GPU/VRAM via the llama backend. Initialises the backend
   * (not a model) on first call. Returns safe fallbacks if detection fails.
   */
  async getHardwareProbe(): Promise<{
    gpuNames: string[]
    vramBytes: number | null
    unified: boolean
  }> {
    try {
      const nlc = await this.getModule()
      this.llama ??= await nlc.getLlama()
      const [gpuNames, vram] = await Promise.all([
        this.llama.getGpuDeviceNames().catch(() => [] as string[]),
        this.llama.getVramState().catch(() => null)
      ])
      return {
        gpuNames,
        vramBytes: vram ? vram.total : null,
        unified: vram ? (vram.unifiedSize ?? 0) > 0 : false
      }
    } catch (error) {
      log.warn('Hardware probe failed:', error)
      return { gpuNames: [], vramBytes: null, unified: false }
    }
  }

  /**
   * Recommends a context size (and other runtime settings) for a specific
   * `.gguf` file on this hardware, by reading the file's own metadata rather
   * than assuming a model tier. Works identically for a catalog download or
   * a model the user added themselves — it only needs a real path to read —
   * so it isn't limited to the curated catalog `recommendModel()` covers.
   */
  async recommendSettingsForFile(
    path: string,
    hardware: { ramBytes: number; vramBytes: number | null; unified: boolean }
  ): Promise<ModelSettingsRecommendation> {
    const nlc = await this.getModule()
    const fileInfo = await nlc.readGgufFileInfo(path)
    const insights = await nlc.GgufInsights.from(fileInfo)

    // Headroom reserved for the OS/app (RAM) and display buffers/driver
    // overhead (VRAM) — same split `modelRecommendation.ts` uses so the
    // catalog-based and per-file recommendations stay consistent.
    const reservedRamBytes = 3 * 1024 ** 3
    const reservedVramBytes = 2 * 1024 ** 3
    const availableRamBytes = Math.max(0, hardware.ramBytes - reservedRamBytes - insights.modelSize)

    // A dedicated GPU can host the KV cache independently of system RAM, so
    // ignoring it (as this used to) meant a machine with a strong GPU and
    // only middling RAM got the same small recommendation as one with no GPU
    // at all — see the identical fix in `modelRecommendation.ts`. Only
    // simulate offload when the GPU actually has room for the model's own
    // weights first; a GPU too small for that wouldn't give 'auto' any real
    // room to work with, so assume CPU-only rather than guess at a partial split.
    const hasCapableGpu =
      !hardware.unified &&
      !!hardware.vramBytes &&
      hardware.vramBytes >= insights.modelSize + reservedVramBytes
    const simulatedGpuLayers = hasCapableGpu ? insights.totalLayers : 0
    const availableVramBytes =
      hasCapableGpu && hardware.vramBytes
        ? Math.max(0, hardware.vramBytes - reservedVramBytes - insights.modelSize)
        : 0

    const candidates = await Promise.all(
      CONTEXT_SIZE_LADDER.map(async (contextSize) => {
        const requirement = await insights.estimateContextResourceRequirementsV2({
          contextSize,
          modelGpuLayers: simulatedGpuLayers
        })
        const fitsRam = requirement.cpuRam <= availableRamBytes
        const fitsVram = !hasCapableGpu || requirement.gpuVram <= availableVramBytes
        return { contextSize, fits: fitsRam && fitsVram }
      })
    )

    const contextSize = pickRecommendedContextSize(candidates, insights.trainContextSize)
    const maxTokens = Math.max(512, Math.round(contextSize * 0.25))

    return {
      contextSize,
      gpuLayers: 'auto',
      maxTokens,
      trainContextSize: insights.trainContextSize,
      totalLayers: insights.totalLayers,
      rationale: buildFileRecommendationRationale(insights, contextSize, hardware, hasCapableGpu)
    }
  }

  private async getModule(): Promise<LlamaModule> {
    this.modulePromise ??= import('node-llama-cpp')
    return this.modulePromise
  }

  private disposeSession(): void {
    try {
      this.session?.dispose()
    } catch (error) {
      log.warn('Session dispose failed:', error)
    }
    this.session = undefined
    this.activeConversationId = undefined
  }

  private async disposeModel(): Promise<void> {
    this.disposeSession()
    try {
      this.contextSequence?.dispose()
      await this.context?.dispose()
      this.summarySequence?.dispose()
      await this.summaryContext?.dispose()
      await this.model?.dispose()
    } catch (error) {
      log.warn('Model dispose failed:', error)
    }
    this.contextSequence = undefined
    this.context = undefined
    this.summarySequence = undefined
    this.summaryContext = undefined
    this.model = undefined
    this.contextSize = undefined
    this.gpuLayersUsed = undefined
    this.gpuLayersTotal = undefined
  }

  private setState(
    patch: Partial<Pick<EngineState, 'status' | 'model' | 'error' | 'contextSize'>>
  ): void {
    if (patch.status !== undefined) this.status = patch.status
    if ('model' in patch) this.currentModel = patch.model
    if ('error' in patch) this.error = patch.error
    if (patch.contextSize !== undefined) this.contextSize = patch.contextSize
    this.emitState()
  }

  private emitState(): void {
    this.emit('state', this.getState())
  }
}

/**
 * Convert Anodex chat turns into `node-llama-cpp` history items.
 *
 * Assistant turns replay their tool calls as `functionCall` entries (name +
 * remembered result) before the final text, so a rebuilt session — after a
 * conversation switch or app restart — retains what the model previously read
 * and ran instead of forgetting its earlier steps.
 *
 * Exported for unit testing.
 */
export function buildHistoryItems(
  systemPrompt: string | undefined,
  history: ChatHistoryTurn[]
): ChatHistoryItem[] {
  const items: ChatHistoryItem[] = []
  if (systemPrompt) items.push({ type: 'system', text: systemPrompt })

  for (const turn of history) {
    if (turn.role === 'user') {
      items.push({ type: 'user', text: turn.content })
      continue
    }
    if (turn.role !== 'assistant') continue

    const response: Array<string | ChatModelFunctionCall> = []
    for (const call of turn.toolCalls ?? []) {
      if (call.status !== 'success' && call.status !== 'error') continue
      response.push({
        type: 'functionCall',
        name: call.name,
        params: {},
        result: rememberedToolResult(call)
      })
    }
    response.push(turn.content)
    items.push({ type: 'model', response })
  }

  return items
}

/** A compact, self-describing record of a past tool call for replay. */
function rememberedToolResult(call: ToolCall): string {
  const body = call.result ?? call.detail ?? ''
  return body ? `${call.title}\n${body}` : call.title
}

/**
 * Local models don't reliably follow "no quotes/punctuation" instructions —
 * strip wrapping quotes/trailing punctuation and hard-truncate to `maxWords`
 * ourselves rather than trusting the model to have obeyed the prompt.
 */
function cleanToastSummary(raw: string, maxWords: number): string | null {
  const cleaned = raw
    .replace(/^["'“”\s]+|["'“”.!?\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  const words = cleaned.split(' ')
  if (words.length <= maxWords) return cleaned
  // Cutting to N words can leave a dangling comma/conjunction ("...gas
  // buildup,") that reads as broken rather than intentionally shortened —
  // drop it and mark the cut with an ellipsis instead.
  const trimmedWords = words
    .slice(0, maxWords)
    .join(' ')
    .replace(/[,;:]+$/, '')
  return `${trimmedWords}…`
}

function buildStats(tokens: number, startedAt: number): GenerationStats {
  const durationMs = Math.max(1, Date.now() - startedAt)
  return {
    tokens,
    durationMs,
    tokensPerSecond: Number((tokens / (durationMs / 1000)).toFixed(1))
  }
}

/** Join successive generation rounds with a blank line, skipping empty ones. */
function appendContent(existing: string, next: string): string {
  const trimmed = next.trim()
  if (!trimmed) return existing
  return existing ? `${existing}\n\n${trimmed}` : trimmed
}

/**
 * A model needs at least its own file size in system RAM just to stage the
 * weights (even layers offloaded to GPU are read from disk into RAM first),
 * plus real headroom for the KV cache/context and the OS/app itself.
 * Refusing up front when free RAM is clearly insufficient turns a confusing
 * (or, observed directly, sometimes uncatchable/crashing) native failure into
 * a plain, actionable message before any native call is even attempted.
 */
const MIN_FREE_RAM_MULTIPLIER = 1.15

/**
 * Reads the GGUF file's own metadata to estimate real RAM needs — weights
 * plus the requested context's KV cache — via node-llama-cpp's resource
 * estimator, so a large context size (which needs real memory of its own)
 * is actually accounted for here instead of only the model file size. Falls
 * back to the plain file-size heuristic if the GGUF read/estimate fails for
 * any reason (e.g. an unusual or corrupt file), so this check never becomes
 * *less* safe than it was before.
 */
async function describeInsufficientMemory(
  info: ModelInfo,
  contextSize: number,
  nlc: LlamaModule
): Promise<string | null> {
  const free = freemem()

  try {
    const fileInfo = await nlc.readGgufFileInfo(info.path)
    const insights = await nlc.GgufInsights.from(fileInfo)
    // gpuLayers: 0 is the conservative case for RAM — weights are staged
    // through RAM regardless of GPU offload (see doc comment above).
    const modelReq = await insights.estimateModelResourceRequirementsV2({ gpuLayers: 0 })
    const contextReq = await insights.estimateContextResourceRequirementsV2({
      contextSize,
      modelGpuLayers: 0
    })
    const required = (modelReq.cpuRam + contextReq.cpuRam) * MIN_FREE_RAM_MULTIPLIER
    if (free >= required) return null
    const freeGb = (free / 1024 ** 3).toFixed(1)
    const requiredGb = (required / 1024 ** 3).toFixed(1)
    return (
      `${info.name} at a ${contextSize.toLocaleString()}-token context needs about ${requiredGb} GB ` +
      `of RAM, but only ${freeGb} GB is free right now. Close other applications, choose a smaller ` +
      'context size, or choose a smaller model, then try again.'
    )
  } catch (error) {
    log.warn('GGUF resource estimate failed, falling back to the file-size heuristic:', error)
    const required = info.sizeBytes * MIN_FREE_RAM_MULTIPLIER
    if (free >= required) return null
    const freeGb = (free / 1024 ** 3).toFixed(1)
    const modelGb = (info.sizeBytes / 1024 ** 3).toFixed(1)
    return (
      `${info.name} is ${modelGb} GB, but only ${freeGb} GB of RAM is free right now. ` +
      'Close other applications, or choose a smaller model, then try again.'
    )
  }
}

/**
 * node-llama-cpp doesn't surface the underlying native diagnostic (e.g. a
 * ggml/Vulkan out-of-memory message) up to JS — a failed load's `message` is
 * typically just a generic "Failed to load model" regardless of cause. Rather
 * than guess at a cause we can't reliably detect, add real, actionable
 * guidance to whatever the engine did report instead of surfacing it bare.
 */
function describeLoadError(error: unknown, info: ModelInfo): string {
  const raw = error instanceof Error ? error.message : String(error)
  const base = raw || 'Failed to load model.'
  return (
    `${base} This often happens when a model needs more RAM or VRAM than is ` +
    `currently available — try CPU-only mode, close other applications, or ` +
    `choose a smaller model than ${info.name}.`
  )
}

function buildFileRecommendationRationale(
  insights: { trainContextSize?: number; totalLayers: number },
  contextSize: number,
  hardware: { ramBytes: number; unified: boolean },
  usedGpuVram: boolean
): string {
  const ramGb = Math.round(hardware.ramBytes / 1024 ** 3)
  const context = contextSize.toLocaleString()
  const memoryLabel = hardware.unified ? 'unified memory' : 'RAM'
  const memoryDescription = usedGpuVram
    ? `${ramGb} GB of ${memoryLabel} plus your GPU's VRAM`
    : `${ramGb} GB of ${memoryLabel}`

  if (insights.trainContextSize && contextSize >= insights.trainContextSize) {
    return (
      `Recommended a ${context}-token context — this model's own training tops out there, ` +
      `and ${memoryDescription} comfortably covers it. GPU offload is left on Auto so ` +
      `the engine can pick the best split for your hardware.`
    )
  }

  return (
    `Recommended a ${context}-token context based on ${memoryDescription} and this ` +
    `model's ${insights.totalLayers} layers. GPU offload is left on Auto so the engine can pick ` +
    `the best split for your hardware.`
  )
}

/**
 * Execute a fallback-detected tool call by invoking its handler directly — the
 * same handler `buildTools()` wired up for native function calling, so this
 * gets the exact same permission gating, UI activity events, and project-memory
 * recording as a real native call. Never throws: a bad call becomes an error
 * string the model can read and correct, matching how native calls behave.
 */
async function runFallbackToolCall(
  functions: Record<string, ToolFunction>,
  call: FallbackToolCall
): Promise<string> {
  const tool = functions[call.name]
  try {
    const result: unknown = await tool.handler(call.arguments)
    return typeof result === 'string' ? result : JSON.stringify(result)
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Singleton — one engine per application process. */
export const llamaService = new LlamaService()
