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
  GbnfJsonSchema,
  LlamaChatResponseChunk,
  LlamaChatResponseFunctionCallParamsChunk
} from 'node-llama-cpp'
import type {
  EngineState,
  ModelInfo,
  ModelLoadOptions,
  ModelSettingsRecommendation,
  RefusedModelLoad
} from '@shared/model.types'
import type {
  ChatCompactRequest,
  ChatCompactResult,
  ContextBudgetUsage,
  ChatHistoryTurn,
  ChatImageInput,
  ChatReplaySuggestionRequest,
  ChatTitleRequest,
  GenerationStopReason,
  GenerationOptions,
  GenerationStats,
  HistoryCompactionEvent,
  ChatUserFile
} from '@shared/chat.types'
import { currentLedgerRevision, type ConversationContext } from '@shared/context.types'
import type { EmailSettings, PermissionMode, WebSearchSettings } from '@shared/settings.types'
import type { ToolCall, ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import type { Plan } from '@shared/plan.types'
import type { McpToolDescriptor } from '@shared/mcp.types'
import type { ToolArtifact } from '@shared/toolArtifacts.types'
import { sanitizeHistoryTurn } from '@shared/chatSanitizer'
import { CONTEXT_SIZE_LADDER } from '@shared/contextSizes'
import { reservedNonHistoryTokens } from '@shared/contextBudget'
import { pickRecommendedContextSize } from '@shared/contextRecommendation'
import { planManualContextCompaction } from '@shared/contextProjection'
import { environmentDateFromPrompt } from '@shared/prompts'
import type { ToolFunction } from '../tools/types'
import { buildTools } from '../tools/registry'
import {
  computeModelToolResultBudget,
  type ModelToolResultBudget
} from '../tools/modelResultBudget'
import { confirmRacingAbort } from '../tools/confirmRacingAbort'
import {
  assembleModelContext,
  rememberToolCallForModel,
  seedContextFromSnapshot
} from './contextAssembler'
import { createBoundedContextShiftStrategy } from './contextShiftStrategy'
import { gbnfSafeSchema } from './gbnfSafeSchema'
import { resolveToolCallingWrapper, fabricatedResultStopTriggers } from './toolCallDialects'
import {
  createNativeLogTail,
  describeNativeLoadFailure,
  describeUnreadableModelFile,
  type NativeLogTail
} from './modelLoadDiagnostics'
import { beginModelLoad, finishModelLoad } from './loadSentinel'
import { DIRECT_ANSWER_BUDGETS } from './directAnswer'
import { foldIntoRollingSummary } from './rollingSummary'
import { buildDeterministicCheckpoint } from './deterministicCheckpoint'
import {
  detectFallbackToolCall,
  stripFallbackCall,
  type FallbackToolCall
} from './toolCallFallback'
import { stripLeakedEngineText, stripSubstantialCodeFences } from '@shared/toolCallText'
import { PendingToolCallTracker } from './pendingToolCalls'
import { appendThinking, shouldPromoteThinkingToAnswer } from './thinkingChannel'
import {
  GenerationDiagnosticsTracker,
  type LocalGenerationDiagnostics
} from './generationDiagnostics'
import { boundToolSurface, maxDirectToolsForContext, type BoundedToolSurface } from './toolSurface'
import { createTaskLedger, type TaskLedger } from '../tools/taskLedger'
import type { WebSourceRegistry } from '../tools/WebSourceRegistry'
import { defaultThoughtTokenBudget, resolveLocalOutputBudget } from './localOutputBudget'
import { LlamaVisionService } from './LlamaVisionService'
import { createAsyncMutex } from './asyncMutex'
import { toStopDetail } from '@shared/stopDetail'
import { appendRoundText } from '@shared/roundText'
import { modelReliabilityStore } from '../models/ModelReliabilityStore'
import { createLogger } from '../utils/logger'
import { createTurnProgress, type TurnProgressSeed } from '../tools/turnProgress'
import {
  buildCompactionSummaryPrompt,
  buildCompactionUpdatePrompt,
  COMPACTION_TRIGGER_RATIO,
  MAX_COMPACTION_SUMMARY_TOKENS,
  MIN_CHARS_TO_SUMMARIZE,
  MIN_SUMMARY_CHARS,
  NODE_LLAMA_CPP_CONTEXT_SHIFT_CRASH_FRAGMENT,
  NODE_LLAMA_CPP_CONTEXT_TOO_LONG_CRASH_FRAGMENT,
  renderTurnsForSummary
} from './compaction'

/**
 * True for either of node-llama-cpp's two distinct, unversioned internal
 * context-shift crash messages (see the doc comments on the two
 * `NODE_LLAMA_CPP_CONTEXT_*_CRASH_FRAGMENT` constants in `compaction.ts`) —
 * one thrown when the context-shift strategy returns history that still
 * doesn't fit, the other thrown *inside* that strategy when even erasing
 * everything erasable can't make the current turn's system prompt plus
 * latest exchange fit on their own.
 */
function isContextShiftCrash(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes(NODE_LLAMA_CPP_CONTEXT_SHIFT_CRASH_FRAGMENT) ||
      error.message.includes(NODE_LLAMA_CPP_CONTEXT_TOO_LONG_CRASH_FRAGMENT))
  )
}

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
 * Native function calling happens inside one opaque `LlamaChatSession` loop,
 * rather than as visible provider rounds. Once a completed tool result has
 * pushed the KV cache this close to its ceiling, stop at the first safe
 * decoder callback and let `boundedChatRunner` continue from its durable tool
 * history. This matches the early-boundary policy used by the stateless vision
 * transport without trying to mutate node-llama-cpp's private in-flight
 * history.
 */
const NATIVE_TOOL_CHECKPOINT_RATIO = 0.72

/** The dynamically-imported `node-llama-cpp` module (ESM-only). */
type LlamaModule = typeof import('node-llama-cpp')

export interface GenerateParams {
  conversationId: string
  /** Assistant message id, used to route tool activity to the right turn. */
  messageId: string
  systemPrompt?: string
  /** Persisted context snapshot for older turns, when one exists. */
  context?: ConversationContext | null
  history: ChatHistoryTurn[]
  prompt: string
  /** Ephemeral current-turn image bytes for any multimodal provider. */
  images?: ChatImageInput[]
  /**
   * `isolated` rebuilds the local chat session from the supplied empty/history
   * state before this call. Cloud providers are already request-isolated.
   * Evidence workflows use this to prevent one bounded phase from inheriting
   * native KV state from an earlier phase with the same durable run id.
   */
  sessionMode?: 'conversation' | 'isolated'
  /**
   * Fraction of the history budget this generation's session rebuild may
   * replay verbatim; the rest is summarized by the Context Ledger compaction
   * path. Legacy null values are normalized before reaching the engine.
   */
  recallWindowFraction?: number | null
  options?: GenerationOptions
  /**
   * Use this model id instead of the globally configured one for this call
   * (an agent run picking its own provider/model — see
   * `RunGenerationIo.providerOverride`). Ignored by the local provider: only
   * one model is ever loaded at a time in this shared engine, so there's no
   * per-call swap, just whatever's currently loaded.
   */
  modelOverride?: string
  /** Called for each decoded text chunk as it is produced. */
  onToken: (token: string) => void
  /**
   * Called for each chain-of-thought text chunk as it is produced, separate
   * from `onToken`'s visible-reply chunks — see `GenerateOutcome.thinking`'s
   * doc comment. Only reasoning-tuned models ever call this at all.
   */
  onThinkingToken?: (token: string) => void
  signal?: AbortSignal
  /** Provider tool-use round cap selected by the shared execution policy. */
  maxProviderRounds?: number
  /** Called after each local mid-turn context shift for shared budget accounting. */
  onContextShift?: () => void
  /** When present, the model is given tools for this generation. */
  tools?: {
    /** Workspace folder for file/command tools, or null for web-only tools. */
    workspaceRoot: string | null
    /** Files the user attached to this chat, which tools may send on. */
    userFiles: ChatUserFile[]
    /** Id of the active project, or null in a general (non-project) chat. */
    projectId: string | null
    permissionMode: PermissionMode
    /** Shell executable used by run_command, if configured. */
    commandShell?: string
    webSearch: WebSearchSettings
    email: EmailSettings
    /** Which memory scopes are on; gates the remember_fact tool and which scope it can write to. */
    memory: { crossChatEnabled: boolean; personalEnabled: boolean; confirmBeforeSaving: boolean }
    /** The conversation's current plan, if any, so plan tools can continue it across turns. */
    plan: Plan | null
    /**
     * Whether this is a goal-directed run, which registers `finish_goal` —
     * see `ToolRuntimeContext.goalRun`. Separate from `enabledTools` because a
     * chat goal run needs the whole toolset plus that one extra tool.
     */
    goalRun: boolean
    /** Restricts which tools get registered at all; null = unrestricted (normal chat). */
    enabledTools?: Set<string> | null
    /** Built-in tools disabled in normal interactive chats. */
    disabledTools: Set<string>
    /** Tools discovered from currently-connected MCP servers (see `ToolRuntimeContext.mcpTools`). */
    mcpTools: McpToolDescriptor[]
    /** Optional focus and artifact sink used by evidence-led workflows. */
    evidenceFocus?: string
    recordArtifact?: (artifact: ToolArtifact) => void
    /** Per-turn web source registry — see `ToolRuntimeContext.webSources`. */
    webSources?: WebSourceRegistry
    beforeTool?: (name: string, args: unknown) => string | null
    onActivity: (call: ToolCall) => void
    confirm: (request: ToolConfirmRequest) => Promise<ToolConfirmResponse>
    /**
     * Shared across every call in a caller-owned multi-cycle/multi-turn task
     * (see `ToolRuntimeContext.ledger`) — undefined means this call has no such
     * task, so a fresh, call-scoped ledger is used with no cross-call effect.
     */
    ledger?: TaskLedger
    /**
     * Ordering carried from a previous context epoch of the same bounded reply
     * — see `TurnProgressSeed`. Undefined for an ordinary turn, which starts
     * its ledger empty exactly as before.
     */
    progressSeed?: TurnProgressSeed
  }
  /**
   * Set when this request is a rebuilt context epoch. The stateful text engine
   * uses it to force a fresh native session; the stateless vision transport
   * also uses it for a first-round preflight, where a rebuild that did not
   * come in under `priorFixedTokens` is fixed-overhead dominance rather than
   * history pressure.
   */
  contextEpoch?: {
    epoch: number
    priorFixedTokens?: number
    cause?: 'proactive' | 'in-turn' | 'loop-guard'
  }
}

export interface GenerateOutcome {
  content: string
  stats: GenerationStats
  stopped: boolean
  /**
   * Why `stopped` is true, when known. `'user'` — a real Stop click/signal
   * abort. `'loop-guard'` — the loop guard force-aborted this generation
   * because a call kept repeating after being blocked (see
   * `LOOP_GUARD_ABORT_AFTER` in `loopGuard.ts`). `'context-limit'` — the
   * turn grew past the hard context ceiling faster than any compaction
   * (proactive or the custom `contextShift.strategy` in
   * `contextShiftStrategy.ts`) could keep up with, and node-llama-cpp's own
   * recovery still couldn't fit it (see `isContextShiftCrash`) — the turn
   * ended early with whatever content had already been produced, which is
   * often substantial rather than empty. `'fixed-context-limit'` — exact
   * wrapper/tokenizer preflight proved the system prompt, current request,
   * and already-routed compact tool surface cannot fit before decoding, so no
   * retry is attempted. `'token-limit'` means the measured safe local output
   * ceiling was reached; streamed text and completed tools are preserved
   * rather than allowing an unfinished function call to consume the native
   * context window. Undefined for every other stop path
   * (fabricated-turn detection, or a provider — Anthropic/OpenAI — that
   * doesn't distinguish reasons at all). Callers that don't care can ignore
   * this and treat any `stopped: true` the same as before; `AgentRunService`
   * uses `'user'` vs. everything else to tell "the user wants everything to
   * stop" apart from "this one turn looped/ran out of room" — only the
   * former should end a whole multi-turn run.
   */
  stopReason?: GenerationStopReason
  /**
   * Free text belonging to `stopReason`, for the reasons whose fixed copy is
   * not enough on its own. Currently only `'provider-error'`, which carries the
   * provider's own message: a turn preserved after a rate limit and one
   * preserved after a malformed request look identical without it, and call for
   * opposite responses from the user.
   */
  stopDetail?: string
  /**
   * True when the model ran a tool and then produced no closing prose about it
   * — its last act was the call, and the round after it came back empty.
   *
   * This separates "finished" from "was still working" without reading the
   * wording of the reply. A turn that has genuinely answered ends with the
   * model writing text and calling nothing; a turn that trails off ends on a
   * tool result it never commented on ("Now let me inspect the page to see if
   * the sandbox renders." — then a command, then silence). `stopped` cannot
   * tell them apart, because this exit is a clean one.
   */
  endedOnToolCall?: boolean
  /** Structured local context boundary cause; separate from the stable UI stop reason. */
  contextEpochCause?: 'proactive' | 'in-turn'
  /** Exact fixed prompt/tool-schema accounting from the active local wrapper. */
  contextBudget?: ContextBudgetUsage
  /**
   * True when this reply named workspace files the task never read or wrote and
   * that are not on disk. Set by `findUnverifiedPathClaims` in
   * `runBoundedChatGeneration`, not by any transport — a provider only reports
   * what it generated, and whether that matches reality is a question about the
   * workspace.
   *
   * It used to be set here, by phrase detectors asking whether the reply
   * *sounded* like it was claiming work ("I've added…", "I fixed…"). That
   * decided a durable reliability penalty from the model's writing style and
   * fired differently across languages and phrasings. The question is the same;
   * the answer now comes from checking the named paths against real state, so a
   * rewording can neither create the flag nor hide it.
   *
   * Callers that run unattended (`AgentRunService`, `SchedulerService`) have no
   * one watching the transcript live, so they surface this afterwards rather
   * than silently reporting success.
   */
  fabricationDetected?: boolean
  /**
   * Real chain-of-thought text the model produced separately from its visible
   * reply (node-llama-cpp's `segmentType: 'thought'` response chunks — only
   * reasoning-tuned models like Qwen3's thinking mode or DeepSeek-R1-style
   * models emit these at all; a typical model leaves this undefined, not an
   * empty string). Undefined for cloud providers (Anthropic/OpenAI) for now —
   * Claude's own separate extended-thinking feature isn't wired up here yet.
   */
  thinking?: string
  /**
   * Bounded, non-sensitive counters for this turn (see
   * `GenerationDiagnosticsTracker`/P0-C in
   * `docs/CONTEXT_ADAPTIVE_RUNTIME_RECOVERY_HANDOFF.md`) — how many tokens
   * went to the visible reply vs. hidden thought vs. in-flight function
   * parameters, and which function call (if any) was still generating when
   * the turn stopped. Undefined for cloud providers, which don't expose this
   * per-channel breakdown.
   */
  generationDiagnostics?: LocalGenerationDiagnostics
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
  private readonly visionService = new LlamaVisionService(
    (message) => {
      this.setState({ status: 'error', error: message })
    },
    () => this.currentModel
  )
  private modulePromise: Promise<LlamaModule> | null = null
  private loadedModule?: LlamaModule
  private llama?: Llama
  /** In-flight (or settled) backend initialisation — see `getLlamaBackend`. */
  private llamaPromise?: Promise<Llama>
  private model?: LlamaModel
  private context?: LlamaContext
  private contextSequence?: LlamaContextSequence
  private activeContextShiftHandler?: () => void
  private session?: LlamaChatSession
  private activeConversationId?: string
  /** Ledger revision represented by the live native session's clean epoch. */
  private activeContextEpochId: string | null = null
  /**
   * Calendar date baked into the live session's system prompt, or null when it
   * has none (see `ensureSession`). Never `undefined`, so the reuse check below
   * compares like with like for a prompt-less session.
   */
  private activeEnvironmentDate: string | null = null
  /** Refreshed before every generation; reused session strategies read it lazily. */
  private activeToolSchemaReserveTokens = 0

  private status: EngineState['status'] = 'unloaded'
  private currentModel?: ModelInfo
  private contextSize?: number
  /** Tail of llama.cpp's own log, read only when a load fails. */
  private readonly nativeLog: NativeLogTail = createNativeLogTail()
  private gpuLayersUsed?: number
  private gpuLayersTotal?: number
  private error?: string
  /**
   * Advisory record of the last load refused before the engine was touched —
   * see {@link RefusedModelLoad}. Never affects {@link status}: the engine it
   * describes is the one that *didn't* change.
   */
  private refusedLoad?: RefusedModelLoad
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
  /**
   * Serializes every model-touching operation onto the single loaded model.
   * The local vision runtime is a `llama-server` started with `--parallel 1`,
   * so a second concurrent request — a toast summary or chat-title generation
   * firing while a reply is still streaming — drops the in-flight HTTP stream
   * and surfaces as a raw `terminated` error. This lock makes those auxiliary
   * calls *defer* until the active generation finishes instead of racing it.
   * Acquired only at the public entry points (`generate`, `summarizeForToast`,
   * `generateChatTitle`, `compactConversationContext`); the shared internal
   * summary helpers run under the caller's already-held lock, so a mid-turn
   * compaction never deadlocks against it.
   */
  private readonly modelLock = createAsyncMutex()

  /**
   * Whether a one-shot summarizer — inbox digest, chat title, toast summary —
   * has an engine to run on right now.
   *
   * Those callers all return `null` rather than throwing, so without this the
   * caller cannot tell "the model was still loading" from "the model answered
   * with something unusable". They read the same from the outside and mean
   * opposite things: the first fixes itself in a few seconds, the second is a
   * fault worth telling the user about.
   */
  canSummarize(): boolean {
    return this.status === 'ready' && (this.model !== undefined || this.visionService.active)
  }

  getState(): EngineState {
    return {
      status: this.status,
      model: this.currentModel,
      contextSize: this.contextSize,
      gpuLayersUsed: this.gpuLayersUsed,
      gpuLayersTotal: this.gpuLayersTotal,
      error: this.error,
      refusedLoad: this.refusedLoad,
      vision: this.visionService.active,
      generating: this.generating,
      contextTokensUsed: this.contextSequence?.nextTokenIndex,
      contextTokensConversationId: this.activeConversationId
    }
  }

  /**
   * Approximate "input tokens" for a turn — tokenizes only the new prompt
   * text, not the full conversation history/system prompt. Anodex's local
   * engine reuses the KV cache turn-over-turn rather than rebilling the full
   * context like a cloud API, so there's no equivalent of a real "prompt
   * tokens" figure; this is a pragmatic proxy for how much new text the user
   * contributed this turn, used only for the token-activity usage stats.
   */
  countPromptTokens(prompt: string): number {
    if (this.visionService.active) return this.visionService.countPromptTokens(prompt)
    if (!this.model) return 0
    return this.model.tokenize(prompt).length
  }

  /**
   * Load a model into the engine, replacing any currently loaded one.
   *
   * Holds the single-model lock for the whole load: this disposes the live
   * context, sequence and model, and doing that while a decode is running on
   * them is a native crash rather than a catchable error. Nothing stopped that
   * before — both IPC entry points (`Models.load`, and `Models.delete` via
   * `unload`) call straight through while a reply may still be streaming.
   *
   * `loadingModel` is still set synchronously, before the first await, so a
   * genuine duplicate call fails fast instead of quietly queueing behind the
   * first and loading the same model twice.
   */
  async loadModel(options: ModelLoadOptions, info: ModelInfo): Promise<EngineState> {
    if (this.loadingModel) {
      throw new Error('Another model is already loading. Wait for it to finish first.')
    }
    this.loadingModel = true
    const release = await this.acquireModelLock()
    try {
      return await this.loadModelInternal(options, info)
    } finally {
      this.loadingModel = false
      release()
    }
  }

  /** The body of {@link loadModel}, run with the model lock already held. */
  private async loadModelInternal(
    options: ModelLoadOptions,
    info: ModelInfo
  ): Promise<EngineState> {
    const requestedSize = options.contextSize ?? 16384
    const nlc = await this.getModule()
    const memoryIssue = await describeInsufficientMemory(info, requestedSize, nlc)
    if (memoryIssue) {
      log.warn('Refusing to load model:', memoryIssue)
      // Recorded WITHOUT touching status/model/error. This runs before
      // `unloadInternal()` below, so a previously loaded model is still fully
      // loaded, still holds its session, and can still generate. Reporting
      // `status: 'error'` here — as this used to — swapped the live model's
      // `ModelInfo` for the refused one and tripped `generateInternal`'s
      // `status !== 'ready'` gate, so a refusal that changed nothing left the
      // user unable to chat until they re-loaded the old model by hand.
      //
      // The throw still becomes a toast (`model.handlers.ts` turns it into an
      // `err(...)`); `refusedLoad` is the persistent copy the Models tab shows,
      // since a toast this long and this actionable shouldn't be the only
      // place the explanation exists.
      this.setState({ refusedLoad: { model: info, reason: memoryIssue } })
      throw new Error(memoryIssue)
    }

    await this.unloadInternal()
    // A new attempt supersedes any refusal on record, whatever its outcome.
    this.setState({ status: 'loading', model: info, error: undefined, refusedLoad: undefined })
    // The requested size, and whether the caller actually named one. Without
    // this the only record of a load is the size that came *out*, so a model
    // running at half the configured context is indistinguishable from one the
    // caller asked to be small — which cost a long investigation once already.
    log.info('Loading model', info.name, {
      requestedContextSize: requestedSize,
      callerAskedFor: options.contextSize ?? null,
      gpuLayers: options.gpuLayers ?? 'auto'
    })

    // Everything below this line can take the whole process down without
    // raising anything catchable — see `loadSentinel.ts`. The record is
    // cleared in the `finally`, so only a real crash leaves one behind.
    beginModelLoad({
      modelPath: info.path,
      modelName: info.name,
      gpuLayers: options.gpuLayers ?? 'auto',
      contextSize: requestedSize,
      vision: Boolean(options.visionProjectorPath),
      startedAt: new Date().toISOString()
    })

    try {
      if (options.visionProjectorPath) {
        await this.visionService.load({ ...options, contextSize: requestedSize })
        this.contextSize = requestedSize
        this.gpuLayersUsed =
          options.gpuLayers === 'auto' || options.gpuLayers === undefined
            ? undefined
            : options.gpuLayers
        this.gpuLayersTotal = undefined
        this.setState({ status: 'ready', error: undefined, contextSize: requestedSize })
        log.info('Vision model ready:', info.name, `(ctx ${this.contextSize})`)
        return this.getState()
      }

      const llama = await this.getLlamaBackend()
      this.model = await llama.loadModel({
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
      const message = describeLoadError(error, info, this.nativeLog.lines())
      log.error('Failed to load model:', message)
      await this.visionService.unload()
      await this.disposeModel()
      this.setState({ status: 'error', model: info, error: message })
      throw new Error(message)
    } finally {
      // A caught failure is not a crash — the app is alive and has already
      // told the user what went wrong, so it needs no recovery prompt.
      finishModelLoad()
    }
  }

  /**
   * Unload the current model and free all associated resources. Takes the
   * model lock for the same reason {@link loadModel} does — this disposes the
   * context a running decode may still be using.
   */
  async unload(): Promise<EngineState> {
    const release = await this.acquireModelLock()
    try {
      return await this.unloadInternal()
    } finally {
      release()
    }
  }

  /** The body of {@link unload}, run with the model lock already held. */
  private async unloadInternal(): Promise<EngineState> {
    await this.visionService.unload()
    await this.disposeModel()
    // A refusal on record says "the load you asked for didn't happen, and the
    // engine is untouched" — once the engine is deliberately emptied there is
    // no untouched engine left for it to describe.
    this.setState({
      status: 'unloaded',
      model: undefined,
      error: undefined,
      refusedLoad: undefined
    })
    return this.getState()
  }

  /**
   * Forget the recorded {@link EngineState.refusedLoad} once the user has
   * answered it in the Models tab.
   *
   * Deliberately does not take the model lock: it touches no native resource,
   * only the advisory record, so dismissing a notice must still work while a
   * reply is streaming.
   */
  dismissRefusedLoad(): void {
    if (!this.refusedLoad) return
    this.setState({ refusedLoad: undefined })
  }

  /**
   * Acquire the single-model serialization lock. Resolves to a `release`
   * callback once any prior holder finishes. See {@link modelLock}.
   */
  private acquireModelLock(): Promise<() => void> {
    return this.modelLock.acquire()
  }

  /**
   * Whether an interactive/scheduled reply is currently generating. Auxiliary
   * callers (e.g. the scheduler) check this to avoid queuing background work
   * behind a live reply. Does not include the short summary/title helpers,
   * which the model lock already serializes.
   */
  isGenerating(): boolean {
    return this.generating
  }

  /**
   * Generate an assistant reply, streaming decoded tokens via `onToken`.
   * Holds the single-model lock for the whole turn so no auxiliary call can
   * race the underlying runtime (see {@link modelLock}).
   */
  async generate(params: GenerateParams): Promise<GenerateOutcome> {
    const release = await this.acquireModelLock()
    try {
      return await this.generateInternal(params)
    } finally {
      // The single authoritative reset. The lock is held for this entire call,
      // so by the time it returns — however it returns — nothing is generating.
      // `generateInternal` has its own `finally` for the decode loop, but the
      // setup between binding the tool surface and entering that `try`
      // (`boundFunctionsForTurn`, `measureContextBudget`) is covered by nothing:
      // a throw there used to leave this flag stuck true for the rest of the
      // process, failing every later turn and leaving the UI showing a
      // generation that was not happening.
      if (this.generating) {
        this.generating = false
        this.emitState()
      }
      release()
    }
  }

  private async generateInternal(params: GenerateParams): Promise<GenerateOutcome> {
    if (this.status !== 'ready' || (!this.context && !this.visionService.active)) {
      throw new Error('No model is loaded. Load a model from the Models tab first.')
    }
    // An invariant, not a contention case: `generate()` is the only caller and
    // holds the model lock across this whole call, clearing the flag in its
    // `finally`, so a second turn can never observe the first still running.
    // Reaching this means either that lock was bypassed or the flag leaked —
    // both bugs, and both far better surfaced here than by two turns decoding
    // into the same native context. This used to throw an exported
    // "already generating" constant that `AgentRunService` and
    // `CriticalThinkingService` pattern-matched as *transient*, which meant a
    // leaked flag disguised itself as ordinary busyness and was retried
    // against forever.
    if (this.generating) {
      throw new Error('Internal: a generation is already in progress on this engine.')
    }

    if (this.visionService.active) {
      this.generating = true
      this.emitState()
      try {
        return await this.visionService.generate(params)
      } finally {
        this.generating = false
        this.emitState()
      }
    }

    // Take the lock before any awaited setup touches the shared context/session.
    // `ensureSession()` can clear and rebuild the native KV cache, so this
    // pre-generation work must be covered by the same single-generation guard
    // as the decode loop itself.
    this.generating = true
    this.emitState()
    const startedAt = Date.now()

    // Any tool activity at all this turn (attempted, denied, errored, or
    // succeeded). Reported to the caller so a turn that produced nothing can be
    // distinguished from one that worked; the per-outcome flags that used to sit
    // beside it existed only to gate the prose detectors and went with them.
    let spokeSinceLastTool = false
    let hadAnyToolAttempt = false
    // Running count of tool activity, so a single round can tell whether it
    // produced any of its own — see the thinking-promotion decision below,
    // which must not fire for a round whose visible artifact is a tool card.
    let toolActivityCount = 0
    const currentModel = this.currentModel
    let functions: Record<string, ToolFunction> | undefined
    // Filled in below once `genController` exists — see `buildToolFunctions`'s
    // doc comment for why this can't just be passed in directly.
    const abortBox: { current: (() => void) | null } = { current: null }
    const signalBox: { current: AbortSignal | null } = { current: null }
    // Same reasoning as abortBox/signalBox above, but filled in once the real
    // context accounting for this turn is measured below (`contextBudget`) —
    // before that, tools fall back to their own existing disk-oriented caps.
    const modelResultBudgetBox: { current: ModelToolResultBudget | null } = { current: null }
    // A tool's terminal activity event happens while node-llama-cpp is still
    // resolving the function handler. It is too early to abort there: the
    // library has not yet appended that result to its in-flight history. Arm a
    // checkpoint here, then request it from the next decoder callback, which
    // only runs after the completed result has been handed back to the native
    // loop. The bounded outer runner independently retains the emitted tool
    // call before it starts the fresh context epoch.
    const nativeToolCheckpoint = {
      pending: false,
      requested: false,
      request: null as (() => void) | null
    }
    // Streams provisional "running" cards while the model is still generating
    // a write/edit call's params (see PendingToolCallTracker's doc comment).
    const pendingToolCalls = new PendingToolCallTracker()
    // Bounded per-turn counters explaining where the output budget went at a
    // bounded stop — see `GenerationDiagnosticsTracker`'s doc comment.
    const diagnostics = new GenerationDiagnosticsTracker()
    // Built BEFORE `ensureSession` (not after, as this used to be ordered) so
    // its measured schema cost can be reserved for by the mid-turn
    // context-shift strategy the session construction wires up — see
    // `toolSchemaReserveTokens`'s doc comment for why that reservation is
    // necessary, not just nice-to-have. `buildToolFunctions` only needs
    // `getModule()` and the (still-empty) abort/signal boxes by reference;
    // it doesn't touch `session`/`contextSequence`, so this reordering is safe.
    functions = await this.buildToolFunctions(
      params,
      (call) => {
        hadAnyToolAttempt = true
        // Node-llama-cpp runs its own tool loop inside one `promptWithMeta`
        // call, so there is no round boundary to read the ending from. Track
        // it directly instead: a settled call clears the flag, and any visible
        // token after it sets it again, leaving "did the model say anything
        // after its final tool result" true at the end.
        if (call.status !== 'running') spokeSinceLastTool = false
        toolActivityCount++
        if (call.status !== 'running') nativeToolCheckpoint.pending = true
        if (call.status !== 'running') diagnostics.recordToolCallSettled()
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
      },
      abortBox,
      signalBox,
      modelResultBudgetBox,
      (name) => pendingToolCalls.claim(name)
    )
    let toolSchemaReserveTokens = this.estimateToolSchemaTokens(functions)
    if (this.contextSize) {
      // The exact surface is routed after the wrapper exists. Avoid letting
      // the pre-session all-tools estimate erase every old turn first; the
      // routed surface is intentionally capped near this share of context.
      toolSchemaReserveTokens = Math.min(
        toolSchemaReserveTokens,
        Math.floor(this.contextSize * 0.35)
      )
    }

    let session: LlamaChatSession = await this.ensureSession(
      params.conversationId,
      params.systemPrompt,
      params.history,
      params.context,
      toolSchemaReserveTokens,
      'onLoad',
      params.sessionMode === 'isolated' || params.contextEpoch !== undefined,
      params.recallWindowFraction
    )

    // Proactive compaction: if this ongoing session's native KV cache is
    // already near the context limit, rebuild it (through the same
    // summarization path `ensureSession` uses on conversation switch) before
    // starting this turn, rather than waiting for node-llama-cpp's own
    // context shift to fail mid-generation. `params.history` — the persisted
    // turns — is the correct source of truth here since this turn's new
    // prompt hasn't been persisted yet.
    const usageRatio = this.contextSize
      ? (this.contextSequence?.nextTokenIndex ?? 0) / this.contextSize
      : 0
    if (usageRatio > COMPACTION_TRIGGER_RATIO) {
      log.info(`Context usage at ${Math.round(usageRatio * 100)}% — compacting before this turn.`)
      session = await this.recompactSession(params, 'proactive', toolSchemaReserveTokens)
      diagnostics.recordContextShift()
    }

    // Tool schemas are fixed prompt overhead: history compaction cannot make
    // them smaller. Keep likely tools native and expose every deferred tool
    // through a compact discover/describe/call gateway when the full surface
    // would crowd out the model's reply. The fit measurement below uses the
    // real wrapper + tokenizer, including function documentation, rather than
    // the JSON approximation used before a session exists.
    const surface = await this.boundFunctionsForTurn(session, functions, params)
    functions = Object.keys(surface.functions).length > 0 ? surface.functions : undefined
    const measuredContextBudget = this.measureContextBudget(
      session,
      params.prompt,
      functions,
      surface
    )
    const outputBudget = resolveLocalOutputBudget({
      contextSize: measuredContextBudget.contextSize,
      inputLimitTokens: measuredContextBudget.inputLimitTokens,
      fixedTokens: measuredContextBudget.fixedTokens,
      promptTokens: measuredContextBudget.promptTokens,
      recallWindowFraction: params.recallWindowFraction,
      requestedMaxTokens: params.options?.maxTokens,
      hasFunctions: functions != null
    })
    const contextBudget: ContextBudgetUsage = {
      ...measuredContextBudget,
      requestedMaxOutputTokens: outputBudget.requestedMaxTokens,
      effectiveMaxOutputTokens: outputBudget.effectiveMaxTokens
    }
    toolSchemaReserveTokens = contextBudget.toolSchemaTokens
    this.activeToolSchemaReserveTokens = toolSchemaReserveTokens

    // Real, measured accounting for this turn is now known — every tool call
    // from here on (they all happen later, inside the prompt/generation loop
    // below) sees a budget sized to what's actually left, not a disk-safety
    // byte limit that has nothing to do with the active context.
    modelResultBudgetBox.current = computeModelToolResultBudget({
      contextSizeTokens: contextBudget.contextSize,
      inputLimitTokens: contextBudget.inputLimitTokens,
      fixedTokens: contextBudget.fixedTokens
    })

    if (
      outputBudget.clamped &&
      outputBudget.requestedMaxTokens !== undefined &&
      outputBudget.requestedMaxTokens > outputBudget.effectiveMaxTokens
    ) {
      log.info('Clamped local output budget to measured context capacity', {
        requestedMaxTokens: outputBudget.requestedMaxTokens,
        effectiveMaxTokens: outputBudget.effectiveMaxTokens,
        fixedTokens: contextBudget.fixedTokens,
        inputLimitTokens: contextBudget.inputLimitTokens,
        hasFunctions: functions != null
      })
    }

    if (contextBudget.fixedTokens > contextBudget.inputLimitTokens) {
      log.warn('Fixed context does not fit before generation', {
        fixedTokens: contextBudget.fixedTokens,
        inputLimitTokens: contextBudget.inputLimitTokens,
        systemTokens: contextBudget.systemTokens,
        promptTokens: contextBudget.promptTokens,
        toolSchemaTokens: contextBudget.toolSchemaTokens,
        activeToolCount: contextBudget.activeToolCount,
        deferredToolCount: contextBudget.deferredToolCount
      })
      this.generating = false
      this.emitState()
      return {
        content: '',
        stats: buildStats(0, startedAt),
        stopped: true,
        stopReason: 'fixed-context-limit',
        contextBudget,
        generationDiagnostics: diagnostics.snapshot()
      }
    }

    let visibleContent = ''
    // Real chain-of-thought text from a reasoning-tuned model (node-llama-cpp's
    // `segmentType: 'thought'` chunks — see `GenerateOutcome.thinking`'s doc
    // comment), accumulated across every round of this turn. Kept separate
    // from `visibleContent`; the existing round-level fallback (below, in the
    // main loop) still promotes a round's segment text INTO the visible reply
    // when that round produced no real answer at all, unchanged — this only
    // captures thinking that coexisted with a genuine visible answer.
    let thinkingText = ''
    let tokenCount = 0
    let stopped = false
    let terminalStopReason: GenerateOutcome['stopReason']
    // Set only by the loop guard's abort (see `abortBox` below) — distinct
    // from `genController.signal.aborted`, which also goes true on a plain
    // user stop (forwarded into it) or the pre-existing fabricated-turn
    // abort, neither of which should get the loop-guard-specific stopReason.
    let loopGuardAborted = false
    const originalPrompt = params.prompt
    let prompt = params.prompt
    const hasEditTool = Boolean(
      functions &&
      ('write_file' in functions || 'edit_file' in functions || 'patch_file' in functions)
    )
    // One controller combines the caller's Stop signal with internal
    // execution guards such as context and repeated-tool boundaries.
    const genController = new AbortController()
    const forwardAbort = () => genController.abort()
    if (params.signal) {
      if (params.signal.aborted) genController.abort()
      else params.signal.addEventListener('abort', forwardAbort, { once: true })
    }
    // Now that it exists, let the loop guard (see `checkLoopGuard` in
    // `loopGuard.ts`) reach it through the box passed into buildToolFunctions.
    abortBox.current = () => {
      loopGuardAborted = true
      genController.abort()
    }
    // Same reasoning — lets the confirm wrapper (see `buildToolFunctions`'s
    // `confirm` field) race a pending confirmation against this generation's
    // own abort, not just the caller's outer signal.
    signalBox.current = genController.signal
    const recordGeneratedTokens = (count: number): void => {
      tokenCount += Math.max(0, count)
      if (
        tokenCount < outputBudget.effectiveMaxTokens ||
        genController.signal.aborted ||
        params.signal?.aborted
      ) {
        return
      }
      terminalStopReason = 'token-limit'
      log.warn('Generated output reached the safe local token budget', {
        effectiveMaxTokens: outputBudget.effectiveMaxTokens,
        observedGeneratedTokens: tokenCount,
        ...diagnostics.snapshot()
      })
      genController.abort()
    }
    // A real user stop takes priority in the reported reason even if the
    // loop guard also fired around the same moment — vanishingly unlikely,
    // but "the user asked to stop" is the more actionable thing to report.
    const currentStopReason = (): GenerateOutcome['stopReason'] => {
      if (params.signal?.aborted) return 'user'
      if (loopGuardAborted) return 'loop-guard'
      return terminalStopReason
    }
    nativeToolCheckpoint.request = () => {
      if (
        !nativeToolCheckpoint.pending ||
        nativeToolCheckpoint.requested ||
        !this.contextSize ||
        (this.contextSequence?.nextTokenIndex ?? 0) <
          Math.floor(this.contextSize * NATIVE_TOOL_CHECKPOINT_RATIO)
      ) {
        return
      }

      nativeToolCheckpoint.requested = true
      terminalStopReason = 'context-limit'
      log.info('Stopping native tool loop at a safe context checkpoint', {
        usedTokens: this.contextSequence?.nextTokenIndex ?? 0,
        contextSize: this.contextSize,
        thresholdTokens: Math.floor(this.contextSize * NATIVE_TOOL_CHECKPOINT_RATIO)
      })
      genController.abort()
    }
    // Mid-generation shifts (node-llama-cpp's own `contextShift.strategy`,
    // wired up once per session in `ensureSession`'s `onShift`) are the
    // dominant, expected source of shifts during a long turn — observed
    // directly: 7 of them inside a single round of one live audit turn, none
    // of which touch the rarer whole-session `recompactSession` retries
    // (`proactive`/`reactive`, counted separately above). Without composing
    // both here, `diagnostics.contextShifts` silently undercounts to zero on
    // exactly the turns where it matters most.
    this.activeContextShiftHandler = () => {
      diagnostics.recordContextShift()
      params.onContextShift?.()
    }
    try {
      const grammar =
        params.options?.jsonSchema && functions == null && this.llama
          ? await this.llama.createGrammarForJsonSchema<GbnfJsonSchema>(
              gbnfSafeSchema(params.options.jsonSchema) as GbnfJsonSchema
            )
          : undefined
      for (let round = 0; ; round++) {
        let roundContent = ''
        let roundSegment = ''
        // Snapshot so this round can tell whether it produced tool activity of
        // its own, independent of earlier rounds.
        const toolActivityBeforeRound = toolActivityCount
        const promptOptions = {
          temperature: params.options?.temperature,
          topP: params.options?.topP,
          maxTokens: outputBudget.effectiveMaxTokens,
          // Sub-budget within maxTokens, not additional — see
          // `GenerationOptions.thoughtTokens`'s doc comment. A turn that
          // structurally requires visible output — a function call, or a
          // grammar-constrained reply the caller has to parse — gets the
          // default guaranteed-visible reserve when it names no budget of its
          // own, rather than leaving hidden reasoning free to consume the
          // whole cap before the answer begins. Observed directly: Critical
          // Thinking's grammar-constrained coverage assessments (1,024-token
          // cap, no requested budget) spent ~700 tokens thinking and had
          // their JSON cut off mid-string on 19 of 21 rounds, because
          // node-llama-cpp's own default thought budget is a fraction of the
          // whole CONTEXT (24,576 tokens at 32K) — far above any single
          // bounded phase's cap, so effectively no bound at all. An ordinary
          // free-text turn still gets no default: finishing its own thinking
          // before answering is normal there.
          //
          // Whatever the source, the budget is clamped to
          // `defaultThoughtTokenBudget` — see that function's doc comment for
          // why the effective cap alone is not a safe clamp.
          budgets: (() => {
            const thoughtCeiling = defaultThoughtTokenBudget(outputBudget.effectiveMaxTokens)
            const requiresVisibleOutput = functions != null || grammar != null
            const requested =
              params.options?.thoughtTokens ?? (requiresVisibleOutput ? thoughtCeiling : undefined)
            if (requested == null) return undefined
            const budget = Math.max(0, Math.min(requested, thoughtCeiling))
            // Both hidden-output segment types get the same budget.
            // node-llama-cpp budgets "thought" and "comment" separately, and
            // an unset one defaults to a fraction of the whole CONTEXT — far
            // above any single phase's cap. This code treats every segment
            // chunk as hidden reasoning (see `onResponseChunk`) and counts it
            // against the same hard ceiling, so budgeting only one of the two
            // leaves the other free to consume the call, depending on which
            // segment type the resolved chat wrapper happens to emit.
            return { thoughtTokens: budget, commentTokens: budget }
          })(),
          // node-llama-cpp's standard repeatPenalty is a soft probability
          // nudge and doesn't prevent verbatim broken-record looping — DRY
          // (Don't Repeat Yourself) sampling is the library's purpose-built
          // defense for that exact failure mode, but ships disabled by
          // default. Observed directly: gemma4-coding-Q8_0, deep into a
          // heavily-compacted long conversation, got stuck re-emitting the
          // same two sentences verbatim for 150+ seconds straight without
          // ever producing a stop token, burning through most of the
          // per-turn token budget on pure repetition. `strength: 0.8` is the
          // library's own recommended default.
          dryRepeatPenalty: { strength: 0.8 },
          // Halt the moment the model starts inventing a tool result rather
          // than calling the tool — see `fabricatedResultStopTriggers`. The
          // round handler below turns that stop into one plain request for the
          // call it skipped.
          customStopTriggers: fabricatedResultStopTriggers(
            this.model?.fileInfo?.metadata?.general?.architecture
          ),
          signal: genController.signal,
          ...(grammar ? { grammar } : { functions }),
          // Force a checkpoint after every native tool call. Wrappers such
          // as Qwen support parallel function sections; without a bound,
          // node-llama-cpp buffers every parsed call in `resFunctionCalls`
          // and does not execute any of them until the section ends. Those
          // pending call tokens count against the native context window but
          // are not part of `chatHistory`, so a mid-section context shift has
          // zero tool results it can compact and can fail even on a fresh
          // turn. A limit of one makes the session execute and append each
          // result before asking the model for the next call. The enclosing
          // `LlamaChatSession` loop still continues the same turn normally.
          maxParallelFunctionCalls: functions != null ? 1 : undefined,
          // Full per-parameter JSON schema docs. Costs more prompt tokens, but
          // omitting them (as this used to) left weaker local models guessing at
          // argument names — observed directly: a 3B model repeatedly attempted
          // `edit_file` without a `path` argument once it stopped seeing the schema.
          documentFunctionParams: functions != null ? true : undefined,
          onResponseChunk: (chunk: LlamaChatResponseChunk) => {
            nativeToolCheckpoint.request?.()
            if (nativeToolCheckpoint.requested) return
            recordGeneratedTokens(chunk.tokens.length)
            if (chunk.type === 'segment') {
              roundSegment += chunk.text
              diagnostics.recordThoughtTokens(chunk.tokens.length)
              params.onThinkingToken?.(chunk.text)
              return
            }
            diagnostics.recordVisibleTokens(chunk.tokens.length)
            // Visible prose after the last tool call — the model came back to
            // comment on what it got. See `GenerateOutcome.endedOnToolCall`.
            if (chunk.text.trim()) spokeSinceLastTool = true
            roundContent += chunk.text
            params.onToken(chunk.text)
          },
          // Surface write/edit calls the moment their params start generating
          // — the disk write itself is milliseconds, but generating a file's
          // content can take the bulk of the turn, and without this the card
          // (and its running animation) only exists for that final blink.
          onFunctionCallParamsChunk: functions
            ? (chunk: LlamaChatResponseFunctionCallParamsChunk) => {
                nativeToolCheckpoint.request?.()
                if (nativeToolCheckpoint.requested) return
                // node-llama-cpp does not include function-argument tokens in
                // `onResponseChunk`, and a completed call can reset its own
                // remaining `maxTokens` to zero (which the library interprets
                // as unlimited). Count parameter chunks here so the app-level
                // ceiling remains enforceable across the complete native loop.
                const parameterTokens =
                  this.model?.tokenize(chunk.paramsChunk).length ??
                  Math.ceil(chunk.paramsChunk.length / 4)
                recordGeneratedTokens(parameterTokens)
                diagnostics.recordFunctionParameterChunk(
                  chunk.callIndex,
                  chunk.functionName,
                  parameterTokens,
                  chunk.paramsChunk.length
                )
                const update = pendingToolCalls.onParamsChunk(round, chunk)
                if (update) params.tools?.onActivity(update)
              }
            : undefined
        }

        // Reactive safety net: node-llama-cpp's own built-in context-shift
        // strategy can still fail mid-generation (e.g. a single turn's tool
        // results grow the KV cache past the proactive check above before the
        // next turn gets a chance to compact). Recompacting rebuilds the
        // session from `params.history` — this turn's own earlier rounds
        // (tool calls/results already produced by round 1+) live only in local
        // variables here and are NOT in `params.history` yet, so recompacting
        // would silently discard them.
        //
        // "Round 0" alone is NOT sufficient to call this safe, despite what
        // it might look like: Anodex's own `round` counter only advances for
        // the fallback-tool-call path (a model that fails to trigger native
        // function calling) — a well-behaved model's ENTIRE multi-tool-call
        // turn (native function calling) happens inside round 0's single
        // `promptWithMeta()` call, via node-llama-cpp's own internal loop.
        // Several tool calls — with real side effects already applied (a
        // file written, a command already run) — can execute before the
        // crash, with zero visible narration text between them, so
        // `roundContent`/`roundSegment` being empty does NOT mean nothing
        // happened. `hadAnyToolAttempt` (set by every tool's `onActivity`,
        // regardless of whether any text streamed) is the actual signal:
        // retrying from a rebuilt session would resend the ORIGINAL prompt
        // with no memory of those calls, risking the model repeating them —
        // harmless for an idempotent read, not for `run_command` or anything
        // else with a real side effect. So this retry is only safe when
        // truly nothing has happened yet: round 0, no streamed content, AND
        // no tool attempted; every other case (including round 1+, which
        // already implies tool work happened) surfaces an honest
        // error/partial-stop instead of silently repeating completed work.
        //
        // Note: detection is a substring match against node-llama-cpp's own
        // internal (unversioned, untyped) error text — there's no exported
        // typed error for this condition to match on instead. A trip-wire
        // test (`__tests__/compaction.test.ts`) reads node-llama-cpp's actual
        // installed source and fails the suite if this fragment ever stops
        // matching, so a future node-llama-cpp upgrade that rewords this
        // message is caught immediately instead of this safety net silently
        // going dark in production.
        let meta: Awaited<ReturnType<typeof session.promptWithMeta>>
        try {
          meta = await session.promptWithMeta(prompt, promptOptions as never)
        } catch (error) {
          const isContextShiftFailure = isContextShiftCrash(error)
          if (genController.signal.aborted) {
            visibleContent = appendRoundText(visibleContent, stripLeakedEngineText(roundContent))
            if (roundSegment.trim()) {
              thinkingText = thinkingText
                ? `${thinkingText}\n\n${roundSegment.trim()}`
                : roundSegment.trim()
            }
          }
          if (
            !isContextShiftFailure ||
            round > 0 ||
            roundContent.length > 0 ||
            roundSegment.length > 0 ||
            hadAnyToolAttempt
          ) {
            // This round's own content streamed via `onResponseChunk` above,
            // so it only ever lived in this loop-local `roundContent`/
            // `roundSegment` — never folded into the outer `visibleContent`,
            // which normally only happens once a round completes
            // successfully. Fold it in before re-throwing so the outer catch
            // returns what actually streamed instead of silently dropping it —
            // otherwise a crash mid-round after substantial output (the common
            // case: it takes real generated content to grow the KV cache
            // enough to hit this) reports back as an empty reply.
            //
            // Not gated on the crash *being* a context shift, as it once was.
            // The user watched this text arrive whatever ended the round, and
            // the outer catch cannot decide whether a turn has work worth
            // keeping if the work is invisible to it.
            if (!genController.signal.aborted) {
              visibleContent = appendRoundText(visibleContent, stripLeakedEngineText(roundContent))
              if (roundSegment.trim()) {
                thinkingText = thinkingText
                  ? `${thinkingText}\n\n${roundSegment.trim()}`
                  : roundSegment.trim()
              }
            }
            throw error
          }
          log.warn('Context shift failed mid-generation; compacting and retrying this round once.')
          session = await this.recompactSession(params, 'reactive', toolSchemaReserveTokens)
          diagnostics.recordContextShift()
          meta = await session.promptWithMeta(prompt, promptOptions as never)
        }

        // Any provisional card whose call never executed this round (aborted
        // mid-generation) must not be left spinning; settle it as interrupted
        // now, before the fallback path below could mistakenly claim its id.
        for (const call of pendingToolCalls.sweep(round)) params.tools?.onActivity(call)

        // Prefer text that actually streamed during this invocation. During
        // a context shift, node-llama-cpp reconstructs `responseText` by
        // joining every string in the compacted model-history item. That can
        // include shortened pre-shift narration or internal compaction text,
        // not just tokens the model generated after the call began. Using it
        // whenever streamed text exists leaks context bookkeeping into the
        // visible reply and can seed a feedback loop where the model repeats
        // that bookkeeping on every later shift. `onResponseChunk` receives
        // every generated visible chunk (including `responsePrefix`), so the
        // assembled value is only a fallback for providers/wrappers that
        // somehow complete without emitting a callback.
        roundContent = roundContent || meta.responseText
        if (roundSegment.trim()) {
          const segment = roundSegment.trim()
          if (roundContent.trim()) {
            // A genuine visible answer AND real thinking both happened this
            // round — keep them separate instead of losing the reasoning.
            thinkingText = appendThinking(thinkingText, segment)
          } else if (
            shouldPromoteThinkingToAnswer(segment, toolActivityCount > toolActivityBeforeRound)
          ) {
            // Some reasoning/think-tagged models emit a short answer inside
            // their thought segment and nothing outside it. Surface that
            // instead of an empty bubble.
            roundContent = segment
          } else {
            // Reasoning without an answer. Keeping it in the thinking channel
            // is the whole point of having two channels — promoting it is what
            // put 74,779 characters of "Let me…" self-talk into the user's
            // reply in chat `c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef`.
            thinkingText = appendThinking(thinkingText, segment)
          }
        }
        // A chat template's own hidden-reasoning boundary marker (e.g.
        // Gemma4ChatWrapper's `<channel|>`) that a model didn't reproduce
        // precisely enough for the wrapper to consume internally — falls
        // through as literal text otherwise. Cleaned here, before any of the
        // detection logic below sees it, so a stray leaked tag can't also
        // confuse the fallback/stalled-intent checks.
        roundContent = stripLeakedEngineText(roundContent)

        log.debug('Generation round complete', {
          round,
          wrapper: session.chatWrapper?.constructor?.name,
          stopReason: meta.stopReason,
          responseTextLength: meta.responseText.length,
          segmentContentLength: roundSegment.length,
          tokenCount
        })

        if (meta.stopReason === 'abort') {
          if (nativeToolCheckpoint.requested) this.disposeSession()
          visibleContent = appendRoundText(visibleContent, roundContent)
          stopped = true
          break
        }

        // A local max-token stop can occur while node-llama-cpp is holding an
        // unfinished function call's arguments. Treat it as a bounded partial
        // result instead of nudging the model into a fresh round with a reset
        // allowance or silently presenting truncated work as complete.
        if (meta.stopReason === 'maxTokens') {
          visibleContent = appendRoundText(visibleContent, roundContent)
          terminalStopReason = 'token-limit'
          stopped = true
          log.warn('Bounded local generation stop diagnostics', diagnostics.snapshot())
          break
        }

        // The model started writing a tool *result*, which only the engine may
        // produce — see `fabricatedResultStopTriggers`. Generation was stopped
        // at the marker, so the invented content was never written; what is
        // missing is the call the model skipped. Ask for it once, plainly,
        // spending a round from the same budget the fallback path uses.
        //
        // Syntax, not intent: this fires on a marker the model cannot
        // legitimately emit, never on what a reply appears to claim.
        if (
          meta.stopReason === 'customStopTrigger' &&
          functions != null &&
          round < MAX_FALLBACK_ROUNDS
        ) {
          visibleContent = appendRoundText(visibleContent, roundContent)
          prompt =
            'You started writing a tool result yourself. Tool results come only from the ' +
            'tools — anything you write there is invented. Call the tool you need and wait ' +
            'for its real result, or, if the task is already done, say what you did.'
          log.info('Stopped a fabricated tool result and asked for the call instead', { round })
          continue
        }

        // Some local models fail to trigger node-llama-cpp's native function
        // calling and instead print the call as plain, unexecuted text (see
        // toolCallFallback.ts). Detect and run it manually so the turn still
        // does real work instead of silently doing nothing.
        //
        // Only the visible reply is scanned, never `roundSegment` (hidden
        // reasoning/"thought" chunks): a tool-shaped JSON draft the model
        // never intended to surface shouldn't get executed just because it
        // appeared in private chain-of-thought. When a round has no visible
        // answer at all, the surfacing step above already promotes the
        // segment text into `roundContent`, so that case is still covered.
        const activeFunctions = functions
        const fallback =
          activeFunctions && round < MAX_FALLBACK_ROUNDS
            ? detectFallbackToolCall(roundContent, new Set(Object.keys(activeFunctions)))
            : null

        if (!fallback || !activeFunctions) {
          // No recoverable call in this round's text: keep what the model wrote
          // and end the turn. Anodex used to run a battery of phrase detectors
          // here — "did this reply claim a change that never happened", "is it
          // stalling", "did it promise an action" — and re-prompt on a match.
          // They were disabled behind a flag and are now gone: a wording match
          // cannot establish that a mutation was skipped, it fires differently
          // across languages and model styles, and it spent a whole extra
          // generation on a slow local model to say so. What actually happened
          // this turn is already recorded in settled tool calls, which is what
          // `finish_goal`'s evidence gate and the bounded runner's verification
          // notes read instead.
          visibleContent = appendRoundText(visibleContent, roundContent)
          break
        }

        // Keep any natural-language commentary the model wrote before the call
        // ("I'll check the file first...") and drop the raw call text itself —
        // the resulting tool card stands in for it in the UI. Also strip any
        // separate code fence in that commentary (see the identical check above).
        const strippedFallbackContent = stripFallbackCall(roundContent, fallback)
        const cleanedRoundContent = hasEditTool
          ? stripSubstantialCodeFences(strippedFallbackContent, originalPrompt)
          : strippedFallbackContent
        visibleContent = appendRoundText(visibleContent, cleanedRoundContent)

        const resultText = await runFallbackToolCall(activeFunctions, fallback)
        prompt = `Tool result for ${fallback.name}:\n${resultText}\n\nContinue the task using this result. If the task is complete, summarize what you did instead of calling another tool.`

        // `genController`, not just the caller's signal: the loop guard aborts
        // through the former, and a guard that fired while this fallback call
        // was running would otherwise buy one more full `promptWithMeta` round
        // before anything noticed.
        if (params.signal?.aborted || genController.signal.aborted) {
          stopped = true
          break
        }
      }

      return {
        content: visibleContent,
        stats: buildStats(tokenCount, startedAt),
        stopped,
        stopReason: stopped ? currentStopReason() : undefined,
        endedOnToolCall: hadAnyToolAttempt && !spokeSinceLastTool,
        contextBudget,
        thinking: thinkingText || undefined,
        generationDiagnostics: diagnostics.snapshot()
      }
    } catch (error) {
      // `genController` also gets aborted internally by the loop guard (see
      // `checkLoopGuard`/`abortBox` above), not just by `params.signal` — if
      // `promptWithMeta` throws instead of resolving with `stopReason:
      // 'abort'` for that case, this still ends the turn cleanly with
      // whatever content was already produced, matching the graceful path
      // below rather than surfacing a confusing raw abort error.
      if (params.signal?.aborted || genController.signal.aborted) {
        if (nativeToolCheckpoint.requested) this.disposeSession()
        log.info('Generation stopped by an abort signal')
        return {
          content: visibleContent,
          stats: buildStats(tokenCount, startedAt),
          stopped: true,
          stopReason: currentStopReason(),
          contextBudget,
          thinking: thinkingText || undefined,
          generationDiagnostics: diagnostics.snapshot()
        }
      }
      // The reactive recovery inside the round loop above only retries a
      // *fresh* round (round 0, no content yet) — a context-shift crash
      // deeper into a multi-tool-call turn can't be safely retried the same
      // way: rebuilding the session from `params.history` loses this turn's
      // own in-progress exchange, so replaying a "continue with this tool
      // result" follow-up prompt against that fresh session would confuse
      // the model with no memory of what it's continuing. Observed directly:
      // a turn with many tool calls can grow past the hard context ceiling
      // faster than the proactive per-turn check (which only runs once, at
      // the *start* of a turn) can catch — previously this threw, producing
      // a fully empty, errored message, and left the session wedged so every
      // later turn failed the exact same way. Instead, end the turn early
      // with whatever content was already produced (often substantial — the
      // failure happens after real tool calls already succeeded) and force
      // the next turn to rebuild from a clean session, rather than cascading
      // into a permanently broken conversation.
      if (isContextShiftCrash(error)) {
        log.warn('Context shift failed mid-turn; ending this turn early with partial content.')
        this.disposeSession()
        return {
          content: visibleContent,
          stats: buildStats(tokenCount, startedAt),
          stopped: true,
          stopReason: 'context-limit',
          contextBudget,
          thinking: thinkingText || undefined,
          generationDiagnostics: diagnostics.snapshot()
        }
      }
      // Any other mid-turn failure gets the same treatment the context-shift
      // crash above already earned, for the same reason: by the time one lands
      // deep in a tool-using turn, `visibleContent` and the completed tool
      // calls behind it are real work, and throwing discards every bit of it —
      // in a multi-cycle reply, the earlier cycles too, since
      // `boundedChatRunner` has no catch of its own. A turn that produced
      // nothing still throws, because there the error message is all there is.
      // The session is disposed either way: after an unexplained failure
      // mid-generation its state is not something the next turn should inherit.
      if (visibleContent.trim() || hadAnyToolAttempt) {
        log.error('Local generation failed mid-turn; keeping the work already done:', error)
        this.disposeSession()
        return {
          content: visibleContent,
          stats: buildStats(tokenCount, startedAt),
          stopped: true,
          stopReason: 'provider-error',
          stopDetail: toStopDetail(error),
          contextBudget,
          thinking: thinkingText || undefined,
          generationDiagnostics: diagnostics.snapshot()
        }
      }
      throw error
    } finally {
      // Hard throws skip the per-round sweep above — settle any provisional
      // cards still unclaimed so nothing is left spinning in the transcript.
      for (const call of pendingToolCalls.sweepAll()) params.tools?.onActivity(call)
      params.signal?.removeEventListener('abort', forwardAbort)
      this.activeContextShiftHandler = undefined
      this.generating = false
      this.emitState()
    }
  }

  /**
   * The narrow, tool-free summarizer used to fold older turns into a rolling
   * summary, exposed for callers that must bound history *before* generation.
   *
   * The node-llama-cpp path never needs this — it compacts inside its own
   * session, which owns the KV cache. The llama-server (vision) path has no
   * session at all: it re-sends the whole conversation every request, exactly
   * like a cloud provider, so without this its history was simply
   * character-truncated and older turns were lost silently. Delegates to the
   * same private summarizer both compaction paths already use, which routes
   * through whichever transport is live.
   */
  summarizeForCompactionLocal(
    transcript: string,
    previousSummary?: string
  ): Promise<string | null> {
    return this.summarizeHistoryForCompaction(transcript, previousSummary)
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
    if (!this.canSummarize()) return null

    const release = await this.acquireModelLock()
    try {
      const truncated = text.length > 1200 ? `${text.slice(0, 1200)}…` : text
      const prompt =
        `Summarize the following in ${maxWords} words or fewer. Reply with only the ` +
        `summary itself — no quotes, no trailing punctuation, no preamble.\n\n${truncated}`
      const finalText = this.visionService.active
        ? await this.visionService.completeText(prompt, {
            maxTokens: Math.max(64, maxWords * 4),
            temperature: 0.2
          })
        : await this.runSummaryPrompt(await this.ensureSummarySequence(1024), prompt, {
            // Generous relative to the target word count — leaves room for a
            // model that still reasons a little before answering, without
            // letting it ramble on at length for what's just a toast title.
            maxTokens: Math.max(64, maxWords * 4),
            temperature: 0.2
          })
      return cleanToastSummary(finalText, maxWords)
    } catch (error) {
      log.warn('Toast summary generation failed:', error)
      return null
    } finally {
      release()
    }
  }

  /** Best-effort short title for a new conversation, based on the first completed turn. */
  async generateChatTitle(request: ChatTitleRequest): Promise<string | null> {
    if (!this.canSummarize()) return null

    const release = await this.acquireModelLock()
    try {
      const context = renderTitleContext(request)
      const prompt =
        'Create a concise title for this AI assistant conversation. The title should describe ' +
        'the actual task or topic, not copy the first words verbatim. Use 3 to 6 words, ' +
        'Title Case, no quotes, no trailing punctuation, no preamble. Prefer an action plus ' +
        `object, such as "Fix Sidebar Hover Preview" or "Plan Garden Layout".\n\n${context}`
      const finalText = this.visionService.active
        ? await this.visionService.completeText(prompt, { maxTokens: 64, temperature: 0.15 })
        : await this.runSummaryPrompt(await this.ensureSummarySequence(1536), prompt, {
            maxTokens: 64,
            temperature: 0.15
          })
      return cleanChatTitle(finalText)
    } catch (error) {
      log.warn('Chat title generation failed:', error)
      return null
    } finally {
      release()
    }
  }

  /**
   * Generate one optional follow-up the composer can offer after a reply. This
   * uses the same isolated summary path as titles and toast summaries, so it
   * cannot change the active chat session, appear in the transcript, or expose
   * workspace tools. A null result intentionally leaves the composer quiet.
   */
  async generateReplaySuggestion(request: ChatReplaySuggestionRequest): Promise<string | null> {
    if (!this.canSummarize()) return null

    const release = await this.acquireModelLock()
    try {
      const context = renderReplaySuggestionContext(request)
      const prompt =
        'Write one concise next request the user could send after this completed assistant reply. ' +
        'It must be a practical continuation, not a summary or a claim that work is done. ' +
        'Use an imperative sentence of at most 16 words. Do not use slash commands, markdown, ' +
        'quotes, a preamble, or more than one sentence. If no useful next request is clear, reply ' +
        'exactly NONE.\n\n' +
        context
      const finalText = this.visionService.active
        ? await this.visionService.completeText(prompt, { maxTokens: 64, temperature: 0.2 })
        : await this.runSummaryPrompt(await this.ensureSummarySequence(2048), prompt, {
            maxTokens: 64,
            temperature: 0.2
          })
      return cleanReplaySuggestion(finalText)
    } catch (error) {
      log.warn('Replay suggestion generation failed:', error)
      return null
    } finally {
      release()
    }
  }

  /**
   * One plain sentence describing what an email thread wants, for the row it
   * occupies in the inbox list — the digest that replaces a raw provider
   * snippet (which is just the first few words of the newest message, quoted
   * boilerplate and all).
   *
   * Shares `summarizeForToast`'s shape deliberately: same throwaway session on
   * the dedicated summary sequence, same model lock, same best-effort `null`
   * on any failure. `null` is a first-class outcome here, not just an error
   * path — no model loaded is the normal state on a fresh install, and the
   * list falls back to the provider snippet, which is exactly what it showed
   * before this existed.
   */
  async digestEmailThread(rendered: string): Promise<string | null> {
    if (!this.canSummarize()) return null

    const release = await this.acquireModelLock()
    try {
      const truncated = rendered.length > 2000 ? `${rendered.slice(0, 2000)}…` : rendered
      const prompt =
        'Below is an email thread. In one sentence of at most 20 words, say what it asks of ' +
        'the reader, or what it tells them if it asks nothing. Write plainly, in the third ' +
        'person, naming who wants what. Do not greet, do not editorialize, and reply with ' +
        'only the sentence — no quotes, no preamble, no bullet points.\n\n' +
        `<thread>\n${truncated}\n</thread>`
      const finalText = this.visionService.active
        ? await this.visionService.completeText(prompt, { maxTokens: 96, temperature: 0.2 })
        : await this.runSummaryPrompt(await this.ensureSummarySequence(4096), prompt, {
            maxTokens: 96,
            temperature: 0.2
          })
      const digest = cleanThreadDigest(finalText)
      // Logged because the silent version of this was genuinely expensive to
      // diagnose: a thinking model answered every digest with truncated
      // scratchpad, the cleaner rightly refused all of it, and the only trace
      // anywhere was an inbox banner saying to try again. The rejected text is
      // the one thing that tells these apart, so it goes in the line.
      if (!digest) {
        log.warn(
          'Email thread digest rejected as unusable:',
          JSON.stringify(finalText.slice(0, 200))
        )
      }
      return digest
    } catch (error) {
      log.warn('Email thread digest failed:', error)
      return null
    } finally {
      release()
    }
  }

  /**
   * Manually compact a conversation into a durable context snapshot.
   *
   * This is an explicit user action, not a pressure-triggered safety net. It
   * keeps the newest turns verbatim and summarizes older exact turns into the
   * active context epoch. The full chat transcript remains untouched for UI
   * and audit history.
   */
  async compactConversationContext(request: ChatCompactRequest): Promise<ChatCompactResult | null> {
    if (this.status !== 'ready' || (!this.model && !this.visionService.active)) {
      throw new Error('No model is loaded. Load a model before compacting chat context.')
    }

    const plan = planManualContextCompaction(request.history, request.context)
    if (!plan) return null

    const transcript = renderTurnsForSummary(plan.older)
    if (transcript.length < MIN_CHARS_TO_SUMMARIZE) return null

    // Chunked rolling fold (see `foldIntoRollingSummary`) — the old
    // single-call path handed this entire transcript to the summarizer's
    // 4,096-token context at once, which a long conversation exceeds.
    // Seeding with the prior epoch's summary makes this a bounded
    // replacement-style update, never an unbounded concatenation across
    // successive manual compactions.
    const countTokens = (text: string): number =>
      this.model ? this.model.tokenize(text).length : this.visionService.countPromptTokens(text)
    const release = await this.acquireModelLock()
    let summary: string | undefined
    try {
      summary = await foldIntoRollingSummary({
        items: plan.older,
        previousSummary: plan.previousSummary ?? undefined,
        renderTranscript: renderTurnsForSummary,
        itemTranscriptCost: (turn) => countTokens(renderTurnsForSummary([turn])),
        countTokens,
        summarize: (chunk, previousSummary) =>
          this.summarizeHistoryForCompaction(chunk, previousSummary)
      })
    } finally {
      release()
    }
    if (!summary || summary === plan.previousSummary) return null

    return {
      conversationId: request.conversationId,
      compactedTurns: plan.compactedTurns,
      snapshot: {
        createdAt: Date.now(),
        reason: 'manual',
        throughMessageId: plan.compactedThroughMessageId,
        removedTurns: plan.previousRemovedTurns + plan.compactedTurns,
        summary
      }
    }
  }

  /**
   * Return the dedicated `summaryContext`/`summarySequence` used by both
   * `summarizeForToast` and `summarizeHistoryForCompaction` — never the
   * active conversation's own context/KV cache. Recreated if the existing
   * context is smaller than `minContextSize`: the two callers ask for
   * different sizes (1024 for a toast title, 4096 for compaction), and a
   * naive `??=` would silently keep whichever one happened to run first,
   * starving the other of room it actually needs.
   */
  private async ensureSummarySequence(minContextSize: number): Promise<LlamaContextSequence> {
    if (!this.model) throw new Error('No model loaded.')
    if (this.summaryContext && this.summaryContext.contextSize < minContextSize) {
      this.summarySequence?.dispose()
      await this.summaryContext.dispose()
      this.summaryContext = undefined
      this.summarySequence = undefined
    }
    this.summaryContext ??= await this.model.createContext({ contextSize: minContextSize })
    this.summarySequence ??= this.summaryContext.getSequence()
    await this.summarySequence.clearHistory()
    return this.summarySequence
  }

  /**
   * Run a single throwaway-session prompt on `sequence` and return its text.
   * Shared by `summarizeForToast` and `summarizeHistoryForCompaction` so the
   * Qwen-thinking-mode workaround and response-accumulation logic exist once.
   */
  private async runSummaryPrompt(
    sequence: LlamaContextSequence,
    prompt: string,
    options: { maxTokens: number; temperature: number }
  ): Promise<string> {
    const nlc = await this.getModule()
    const toolWrapper = this.toolCallingWrapper(nlc)
    let session = new nlc.LlamaChatSession({
      contextSequence: sequence,
      ...(toolWrapper ? { chatWrapper: toolWrapper as never } : {})
    })
    // Qwen 3's chat template defaults to "thinking" mode — we want a direct
    // answer, not a reasoning monologue, so explicitly discourage it when
    // that's the resolved wrapper. Verified directly: without this,
    // `session.prompt()` returned an empty string because the whole reply
    // went into the (unsurfaced) thinking segment.
    //
    // Only some wrappers carry that lever, and a model newer than the bundled
    // wrappers resolves to a plain Jinja one that doesn't — hence the thought
    // budget on the prompt below, which every wrapper honours.
    if (session.chatWrapper instanceof nlc.QwenChatWrapper) {
      session.dispose()
      session = new nlc.LlamaChatSession({
        contextSequence: sequence,
        chatWrapper: new nlc.QwenChatWrapper({ thoughts: 'discourage' })
      })
    }
    try {
      let responseText = ''
      let segmentText = ''
      const meta = await session.promptWithMeta(prompt, {
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        // Closes a thought segment the instant it opens, so the token
        // allowance above buys an answer rather than a scratchpad the callers
        // would only throw away — see `directAnswer.ts`.
        budgets: DIRECT_ANSWER_BUDGETS,
        onResponseChunk: (chunk) => {
          if (chunk.type === 'segment') segmentText += chunk.text
          else responseText += chunk.text
        }
      })
      const finalText = meta.responseText || responseText || segmentText
      // These throwaway summarization sessions use the same chat wrappers
      // (e.g. Gemma4ChatWrapper) as the main conversation, so they're subject
      // to the same special-token leak (see `stripLeakedEngineText`'s
      // docs). Compaction summaries in particular are now shown directly to
      // the user via the in-transcript compaction marker, not just fed back
      // as model context, so a leaked `<channel|>` here would be a new
      // user-visible bug rather than a harmless internal artifact.
      return stripLeakedEngineText(finalText)
    } finally {
      session.dispose()
    }
  }

  /**
   * Return a chat session bound to `conversationId`. When the conversation
   * changes, the session is rebuilt and the prior turns are replayed so context
   * is preserved. Staying on the same conversation reuses the session (and its
   * KV cache) across turns.
   *
   * The one exception is a date rollover: the session's system prompt is baked
   * in at construction, so a conversation left open past midnight would keep
   * telling the model it is yesterday. That's rebuilt too — once per day at
   * most, and only for a conversation actually still in use.
   */
  private async ensureSession(
    conversationId: string,
    systemPrompt: string | undefined,
    history: ChatHistoryTurn[],
    context: ConversationContext | null | undefined,
    toolSchemaReserveTokens: number,
    compactionReason: HistoryCompactionEvent['reason'] = 'onLoad',
    forceRebuild = false,
    recallWindowFraction?: number | null
  ): Promise<LlamaChatSession> {
    // This must happen before the same-conversation fast path. The session's
    // strategy is reused, but the enabled/MCP tool surface can change between
    // turns; its lazy getter below reads this refreshed value.
    this.activeToolSchemaReserveTokens = toolSchemaReserveTokens
    const environmentDate = environmentDateFromPrompt(systemPrompt)
    if (
      !forceRebuild &&
      this.session &&
      this.activeConversationId === conversationId &&
      environmentDate === this.activeEnvironmentDate &&
      (currentLedgerRevision(context)?.id ?? null) === (this.activeContextEpochId ?? null)
    ) {
      return this.session
    }
    if (this.session && this.activeEnvironmentDate && environmentDate) {
      if (environmentDate !== this.activeEnvironmentDate) {
        log.info(
          `Date rolled over from ${this.activeEnvironmentDate} to ${environmentDate} — ` +
            `rebuilding the session so the model isn't told the wrong day.`
        )
      }
    }
    if (!this.context || !this.contextSequence) throw new Error('No model loaded.')

    this.disposeSession()
    try {
      await this.contextSequence.clearHistory()
    } catch (error) {
      log.warn('Failed to clear context sequence history:', error)
    }

    const compacted = await this.compactHistoryForSession(
      systemPrompt,
      history,
      context,
      toolSchemaReserveTokens,
      recallWindowFraction
    )
    if (compacted.removedTurns > 0 || compacted.summaryRebased) {
      this.emit('historyCompacted', {
        conversationId,
        removedTurns: compacted.removedTurns,
        coveredTurns: compacted.coveredTurns,
        reason: compactionReason,
        summarized: compacted.summarized,
        summary: compacted.summary,
        compactedThroughMessageId: compacted.compactedThroughMessageId,
        createdAt: Date.now()
      } satisfies HistoryCompactionEvent)
    }

    const nlc = await this.getModule()
    // See `toolCallingWrapper`: a model whose tool calls the resolved wrapper
    // cannot read back would otherwise narrate them as prose and call nothing.
    const chatWrapper = this.toolCallingWrapper(nlc)
    this.session = new nlc.LlamaChatSession({
      contextSequence: this.contextSequence,
      systemPrompt: compacted.systemPrompt,
      ...(chatWrapper ? { chatWrapper: chatWrapper as never } : {}),
      contextShift: {
        strategy: createBoundedContextShiftStrategy({
          // Context shifts occur inside an active generation. Keep this path
          // deterministic and GPU-free; model summaries remain between turns.
          summarize: buildDeterministicCheckpoint,
          stringifySystemText: (text) =>
            typeof text === 'string' ? text : nlc.LlamaText.fromJSON(text as never).toString(),
          getToolSchemaReserveTokens: () => this.activeToolSchemaReserveTokens,
          // Mid-turn shifts run inside node-llama-cpp's generation loop and
          // are otherwise completely invisible (no historyCompacted event
          // fires here — see `onShift`'s doc comment) — this log line is the
          // only production trace that a shift happened and what it did.
          onShift: (info) => {
            this.activeContextShiftHandler?.()
            const trimmed = [
              info.trimmedUserMessage ? 'the current user message' : '',
              info.trimmedAssistantResponse ? 'the generated assistant response' : ''
            ].filter(Boolean)
            log.info(
              `Context shift: folded ${info.foldedItemCount} exchange(s), ` +
                `${info.foldedEvidenceCallCount} tool result(s) into a ${info.summaryTokens}-token ` +
                `summary${trimmed.length > 0 ? `; trimmed ${trimmed.join(' and ')} to fit` : ''}.`
            )
          }
        })
      }
    })

    const items = buildHistoryItems(compacted.systemPrompt, compacted.history)
    if (items.length > 0) this.session.setChatHistory(items)

    this.activeConversationId = conversationId
    this.activeEnvironmentDate = environmentDate
    this.activeContextEpochId = currentLedgerRevision(context)?.id ?? null
    return this.session
  }

  /**
   * Real-token-count history compaction, replacing the old character-count
   * truncation. Older turns that don't fit within the context budget are
   * summarized by the model (via `summarizeHistoryForCompaction`, never on
   * the active conversation's own context) instead of just dropped, so a
   * long conversation still "remembers" earlier facts after compaction. See
   * `compaction.ts` for the pure budget-splitting logic.
   */
  private async compactHistoryForSession(
    systemPrompt: string | undefined,
    history: ChatHistoryTurn[],
    context: ConversationContext | null | undefined,
    toolSchemaReserveTokens = 0,
    recallWindowFraction?: number | null
  ): Promise<{
    systemPrompt: string | undefined
    history: ChatHistoryTurn[]
    removedTurns: number
    summarized: boolean
    summary?: string
    compactedThroughMessageId?: string | null
    coveredTurns?: number
    summaryRebased?: boolean
  }> {
    const seeded = seedContextFromSnapshot(systemPrompt, history, context)
    const priorCoveredTurns = seeded.applied
      ? (currentLedgerRevision(context)?.coveredTurns ?? 0)
      : 0
    if (!this.contextSize || !this.model) {
      return {
        systemPrompt: seeded.systemPrompt,
        history: seeded.history,
        removedTurns: 0,
        summarized: false
      }
    }

    const countTokens = (text: string): number => this.model!.tokenize(text).length
    const assembled = await assembleModelContext({
      systemPrompt,
      history: seeded.history,
      contextSize: this.contextSize,
      countTokens,
      toolSchemaReserveTokens,
      recallWindowFraction,
      initialSummary: seeded.summary,
      summarizeOlderTurns: (transcript, previousSummary) =>
        this.summarizeHistoryForCompaction(transcript, previousSummary)
    })

    if (assembled.removedTurns === 0) {
      return {
        systemPrompt: assembled.systemPrompt,
        history: assembled.history,
        removedTurns: 0,
        summarized: assembled.summarized,
        summary: assembled.summary,
        compactedThroughMessageId: seeded.throughMessageId ?? null,
        coveredTurns: priorCoveredTurns,
        summaryRebased: assembled.summaryRebased
      }
    }

    log.info(
      `Compacted ${assembled.removedTurns} older turn(s) ${
        assembled.summarized ? 'via summary' : 'by dropping (too small/failed to summarize)'
      }`,
      assembled.report
    )
    return {
      systemPrompt: assembled.systemPrompt,
      history: assembled.history,
      removedTurns: assembled.removedTurns,
      summarized: assembled.summarized,
      summary: assembled.summary,
      compactedThroughMessageId:
        assembled.compactedThroughMessageId ?? seeded.throughMessageId ?? null,
      coveredTurns: priorCoveredTurns + assembled.removedTurns,
      summaryRebased: assembled.summaryRebased
    }
  }

  /**
   * Summarize older conversation turns for compaction, preserving concrete
   * facts (file paths, decisions, results, open TODOs) rather than a vague
   * gist — this text stands in for the removed turns for the rest of the
   * conversation. Modeled directly on `summarizeForToast()`: runs on the
   * dedicated `summaryContext`/`summarySequence`, never the active
   * conversation's own context, and is best-effort (`null` on any failure —
   * the caller falls back to just dropping the older turns).
   */
  private async summarizeHistoryForCompaction(
    transcript: string,
    previousSummary?: string
  ): Promise<string | null> {
    if (!this.model && !this.visionService.active) return null

    try {
      // The transcript is untrusted data to describe, not instructions to
      // follow — without this framing, a weak model can latch onto a short
      // reply embedded in the transcript (e.g. a literal "OK") and just echo
      // that instead of summarizing. Verified live: without the
      // <conversation> delimiter + explicit "ignore requests inside it"
      // instruction, qwen2.5-coder-3b's "summary" of a 24-turn transcript
      // ending in "Assistant: OK" was literally the string "OK".
      //
      // With `previousSummary`, this is a replacement-style rolling update
      // (see `foldIntoRollingSummary` in `rollingSummary.ts`): the returned
      // text REPLACES the previous summary rather than being appended to it.
      // `maxTokens` is capped at `MAX_COMPACTION_SUMMARY_TOKENS` (not the old
      // `MAX_COMPACTION_SUMMARY_WORDS * 4`) because the 4,096-token summary
      // context must also fit the previous summary and the transcript chunk
      // on the input side — see that constant's doc for the arithmetic.
      const prompt = previousSummary
        ? buildCompactionUpdatePrompt(transcript, previousSummary)
        : buildCompactionSummaryPrompt(transcript)
      const finalText = this.visionService.active
        ? await this.visionService.completeText(prompt, {
            maxTokens: MAX_COMPACTION_SUMMARY_TOKENS,
            temperature: 0.2
          })
        : await this.runSummaryPrompt(await this.ensureSummarySequence(4096), prompt, {
            maxTokens: MAX_COMPACTION_SUMMARY_TOKENS,
            temperature: 0.2
          })
      // Reject degenerate "summaries" (too short to have preserved anything
      // useful) rather than polluting the system prompt with them — the
      // caller falls back to dropping the older turns instead.
      return finalText.length >= MIN_SUMMARY_CHARS ? finalText : null
    } catch (error) {
      log.warn('History compaction summary failed:', error)
      return null
    }
  }

  /**
   * Force the active session to be rebuilt (through `ensureSession`'s
   * compaction path) from persisted history, discarding the native KV cache.
   * Used both proactively (context usage nearing the limit) and reactively
   * (node-llama-cpp's own context-shift already failed).
   */
  private async recompactSession(
    params: GenerateParams,
    reason: 'proactive' | 'reactive',
    toolSchemaReserveTokens: number
  ): Promise<LlamaChatSession> {
    this.disposeSession()
    return this.ensureSession(
      params.conversationId,
      params.systemPrompt,
      params.history,
      params.context,
      toolSchemaReserveTokens,
      reason,
      false,
      params.recallWindowFraction
    )
  }

  /**
   * Approximate token cost of `functions`' documented schemas — what
   * `documentFunctionParams: true` (below, in `generate()`'s `promptOptions`)
   * actually adds to what node-llama-cpp renders and re-verifies against the
   * context budget, but which the mid-turn context-shift strategy can never
   * see on its own (`chatHistory` doesn't carry `availableFunctions` — see
   * `BoundedContextShiftDeps.toolSchemaReserveTokens`'s doc comment).
   * Deliberately approximate (JSON-stringified name+description+params,
   * tokenized), not an exact replica of the chat wrapper's own function-
   * schema rendering — a real generation call registers Anodex's full tool
   * catalog (read/write/command/git/plan/memory tools, MCP tools), and even
   * a rough per-tool estimate closes the gap a flat reservation alone
   * couldn't (reproduced live: a project chat's full tool surface at a
   * 4,096-token context measured as fitting with no schema-aware reservation
   * and was still rejected by node-llama-cpp's real, schema-inclusive check).
   * Best-effort: an unstringifiable schema is skipped, not thrown on. The
   * strategy still measures wrapper-rendered history, and node-llama-cpp
   * performs the final schema-inclusive fit check before accepting it.
   */
  private estimateToolSchemaTokens(functions: Record<string, ToolFunction> | undefined): number {
    if (!functions || !this.model) return 0
    let total = 0
    for (const [name, fn] of Object.entries(functions)) {
      try {
        // `fn.params` is `any` (`ToolFunction = ChatSessionModelFunction<any>`)
        // — narrowed to `unknown` before use so it's never propagated unsafely.
        const params: unknown = fn.params
        total += this.model.tokenize(
          JSON.stringify({ name, description: fn.description, params })
        ).length
      } catch {
        // Non-serializable schema — skip; see the doc comment above.
      }
    }
    return total
  }

  /**
   * Select the largest task-relevant native tool surface that leaves useful
   * reply room. Tools that do not fit remain callable through the compact
   * on-demand gateway built by `boundToolSurface`.
   */
  private async boundFunctionsForTurn(
    session: LlamaChatSession,
    functions: Record<string, ToolFunction> | undefined,
    params: GenerateParams
  ): Promise<BoundedToolSurface> {
    if (!this.contextSize) {
      return {
        functions: functions ?? {},
        directToolNames: Object.keys(functions ?? {}),
        deferredToolNames: [],
        routed: false
      }
    }

    const nlc = await this.getModule()
    const shiftReserve = defaultContextShiftReserve(this.contextSize)
    const toolResultHeadroom = Math.max(512, Math.min(3_000, Math.floor(this.contextSize * 0.15)))
    const targetFixedTokens = Math.max(
      0,
      this.contextSize -
        shiftReserve -
        reservedNonHistoryTokens(this.contextSize) -
        toolResultHeadroom
    )
    return boundToolSurface({
      allFunctions: functions,
      define: nlc.defineChatSessionFunction,
      targetFixedTokens,
      maxDirectTools: maxDirectToolsForContext(this.contextSize),
      measureFixedTokens: (candidate) =>
        this.measureContextBudget(session, params.prompt, candidate, {
          functions: candidate ?? {},
          directToolNames: Object.keys(candidate ?? {}),
          deferredToolNames: [],
          routed: false
        }).fixedTokens
    })
  }

  /** Exact fixed-input accounting through the same wrapper/tokenizer used by generation. */
  private measureContextBudget(
    session: LlamaChatSession,
    prompt: string,
    functions: Record<string, ToolFunction> | undefined,
    surface: BoundedToolSurface
  ): ContextBudgetUsage {
    if (!this.contextSize || !this.model) throw new Error('No model context is loaded.')

    const canonicalHistory = session.getChatHistory()
    const initialHistory = canonicalHistory[0]?.type === 'system' ? [canonicalHistory[0]] : []
    const emptyPromptHistory = appendModelResponse(
      appendUserPrompt(initialHistory, '', this.getModuleSyncAppendUser())
    )
    const promptHistory = appendModelResponse(
      appendUserPrompt(initialHistory, prompt, this.getModuleSyncAppendUser())
    )
    const renderedTokens = (
      chatHistory: ChatHistoryItem[],
      availableFunctions?: Record<string, ToolFunction>
    ): number => {
      const { contextText } = session.chatWrapper.generateContextState({
        chatHistory,
        availableFunctions,
        documentFunctionParams: availableFunctions ? true : undefined
      })
      return contextText.tokenize(this.model!.tokenizer).length
    }

    const systemTokens = renderedTokens(emptyPromptHistory)
    const promptWithoutTools = renderedTokens(promptHistory)
    const fixedTokens = renderedTokens(promptHistory, functions)
    const reservedTokens = defaultContextShiftReserve(this.contextSize)

    return {
      contextSize: this.contextSize,
      inputLimitTokens: Math.max(0, this.contextSize - reservedTokens),
      systemTokens,
      promptTokens: Math.max(0, promptWithoutTools - systemTokens),
      toolSchemaTokens: Math.max(0, fixedTokens - promptWithoutTools),
      fixedTokens,
      reservedTokens,
      activeToolCount: Object.keys(functions ?? {}).length,
      deferredToolCount: surface.deferredToolNames.length,
      toolRoutingApplied: surface.routed
    }
  }

  /**
   * `appendUserMessageToChatHistory` is ESM-only like the rest of node-llama-
   * cpp. `measureContextBudget` is synchronous once setup has awaited
   * `getModule()`, so retain the loaded export rather than introducing an
   * async render loop for every candidate tool.
   */
  private getModuleSyncAppendUser(): LlamaModule['appendUserMessageToChatHistory'] {
    const module = this.loadedModule
    if (!module) throw new Error('node-llama-cpp has not finished loading.')
    return module.appendUserMessageToChatHistory
  }

  /**
   * Build the workspace tool set for a generation, or `undefined` if disabled.
   * `abortBox` and `signalBox` are mutable boxes the caller fills in once
   * `genController` exists — `buildToolFunctions` runs before that, so the
   * boxes let the loop guard (and, via `signalBox`, the confirm wrapper
   * below) reach it anyway (same pattern as `plan`/`turnGate` below, just
   * resolved slightly later than those). `modelResultBudgetBox` is the same
   * pattern again, filled in once this turn's real `contextBudget` is
   * measured (see the caller, below).
   */
  private async buildToolFunctions(
    params: GenerateParams,
    onActivity: (call: ToolCall) => void,
    abortBox: { current: (() => void) | null },
    signalBox: { current: AbortSignal | null },
    modelResultBudgetBox: { current: ModelToolResultBudget | null },
    claimPendingToolCallId: (name: string) => string | undefined
  ): Promise<Record<string, ToolFunction> | undefined> {
    if (!params.tools) return undefined
    const nlc = await this.getModule()
    const rawConfirm = params.tools.confirm
    const tools = buildTools(nlc.defineChatSessionFunction, {
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
      goalRun: params.tools.goalRun,
      enabledTools: params.tools.enabledTools ?? null,
      disabledTools: params.tools.disabledTools,
      mcpTools: params.tools.mcpTools,
      evidenceFocus: params.tools.evidenceFocus,
      recordArtifact: params.tools.recordArtifact,
      webSources: params.tools.webSources,
      beforeTool: params.tools.beforeTool,
      // A mutable box, not the plan value itself — shared by every tool call
      // in this generation so `update_plan_step` sees `write_plan`'s result
      // within the same turn (see `ToolRuntimeContext.plan`'s doc comment).
      plan: { current: params.tools.plan },
      // Fresh every generation call, no seeding needed (unlike `plan`) — see
      // `ToolRuntimeContext.turnGate`'s doc comment.
      turnGate: { approved: false },
      // Fresh every generation call, same reasoning as `turnGate` above — see
      // `ToolRuntimeContext.loopGuard`'s doc comment.
      // Fresh every generation call, same reasoning as `turnGate` above — see
      // `ToolRuntimeContext.progress`'s doc comment.
      progress: createTurnProgress(params.tools.progressSeed),
      // Same box pattern as `abortBox`/`signalBox` above — this generation's
      // real context accounting isn't measured until after this method
      // returns (see `contextBudget` below), so it fills in slightly later.
      modelResultBudget: modelResultBudgetBox,
      // Reuse the caller-owned tracker when this call is part of a bounded
      // multi-cycle/multi-turn task (see `ToolRuntimeContext.readCoverage`'s
      // doc comment); otherwise a fresh one with no cross-call effect.
      ledger: params.tools.ledger ?? createTaskLedger(),
      // See `ToolRuntimeContext.abortGeneration`'s doc comment and this
      // method's own doc comment above for why this goes through a box.
      abortGeneration: () => abortBox.current?.(),
      signal: params.signal,
      emit: onActivity,
      claimPendingToolCallId,
      // `rawConfirm` only observes the caller's own outer/per-conversation
      // signal (e.g. `chat.handlers.ts`'s `controller.signal`), which has no
      // visibility into this generation's own internal abort (the loop guard,
      // or the pre-existing fabricated-turn guard). Without this wrapper, a
      // confirm card for a call still waiting on the user can outlive the
      // generation entirely — approving it later would run `spec.run()`
      // (e.g. a real file write) into a turn that already ended, with no
      // model left to see the result. Racing against `signalBox`'s signal
      // (set to `genController.signal` below, once it exists) settles the
      // confirm as denied the moment this generation ends, however it ends.
      confirm: (request) => confirmRacingAbort(rawConfirm, request, signalBox)
    })
    // node-llama-cpp compiles each tool's schema into GBNF on its own — and
    // rejects bounds a cloud provider accepts happily. This is the only seam
    // where the tool declarations meet that compiler, so it is where they are
    // made safe for it; see `gbnfSafeSchema`'s doc comment for what fails and
    // why the bound is dropped rather than lowered.
    return Object.fromEntries(
      Object.entries(tools).map(([name, fn]) => {
        // `fn.params` is `any` (`ToolFunction = ChatSessionModelFunction<any>`)
        // — narrowed to `unknown` before use, as `estimateToolSchemaTokens`
        // above does, so it is never propagated unsafely.
        const params: unknown = fn.params
        return [name, params == null ? fn : { ...fn, params: gbnfSafeSchema(params) }]
      })
    )
  }

  /**
   * The shared native `Llama` backend handle (GPU/CPU detection, not a
   * loaded model), lazily initialized on first call. `EmbeddingService` uses
   * this instead of calling `nlc.getLlama()` itself — this project's own
   * history has multiple documented native-crash incidents from the GPU
   * backend, so a second independent backend instance for the small
   * embedding model is a real, avoidable risk, not just a style preference.
   */
  async getLlamaBackend(): Promise<Llama> {
    // Memoize the *promise*, not the resolved handle. `this.llama ??= await
    // nlc.getLlama()` evaluated the nullish check before the await, so two
    // callers arriving while the first was still initialising both saw
    // `undefined` and both started a backend — precisely the duplicate the doc
    // comment above says to avoid. It is reachable: `EmbeddingService` calls
    // this to index a workspace in the background, which can overlap a model
    // load at startup. `getModule()` below already has this shape.
    this.llamaPromise ??= this.createLlamaBackend()
    try {
      return await this.llamaPromise
    } catch (error) {
      // A failed probe must not poison every later call with a rejected promise.
      this.llamaPromise = undefined
      throw error
    }
  }

  private async createLlamaBackend(): Promise<Llama> {
    const nlc = await this.getModule()
    // llama.cpp's own diagnostics never reach JS — a failed load rejects with a
    // bare "Failed to load model" whatever the cause — so they are captured
    // here instead. See `modelLoadDiagnostics.ts`.
    this.llama = await nlc.getLlama({
      logger: (level, message) => {
        this.nativeLog.record(message)
        if (level === nlc.LlamaLogLevel.error || level === nlc.LlamaLogLevel.fatal) {
          log.warn('llama.cpp:', message)
        }
      }
    })
    return this.llama
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
      const llama = await this.getLlamaBackend()
      const [gpuNames, vram] = await Promise.all([
        llama.getGpuDeviceNames().catch(() => [] as string[]),
        llama.getVramState().catch(() => null)
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

    // Memory headroom reserved for the OS/app and display buffers/driver
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

  /**
   * The chat wrapper for the loaded model, or `undefined` to keep the one
   * node-llama-cpp resolves on its own. See `toolCallDialects.ts` for which
   * families need an override and why the list is deliberately short.
   */
  private toolCallingWrapper(nlc: LlamaModule): object | undefined {
    return resolveToolCallingWrapper(
      nlc,
      this.model?.fileInfo?.metadata?.general?.architecture,
      this.model?.fileInfo?.metadata?.tokenizer?.chat_template
    )
  }

  private async getModule(): Promise<LlamaModule> {
    this.modulePromise ??= import('node-llama-cpp')
    const module = await this.modulePromise
    this.loadedModule = module
    return module
  }

  private disposeSession(): void {
    try {
      this.session?.dispose()
    } catch (error) {
      log.warn('Session dispose failed:', error)
    }
    this.session = undefined
    this.activeConversationId = undefined
    this.activeEnvironmentDate = null
    this.activeContextEpochId = null
  }

  /**
   * Each resource is disposed independently so one throwing (e.g. `context`)
   * can't skip disposing the rest — `dispose()` still clears every field
   * below regardless, so a shared `try` would leak whatever came after the
   * failure without ever surfacing it.
   */
  private async disposeModel(): Promise<void> {
    this.disposeSession()
    await this.disposeQuietly('contextSequence', () => this.contextSequence?.dispose())
    await this.disposeQuietly('context', () => this.context?.dispose())
    await this.disposeQuietly('summarySequence', () => this.summarySequence?.dispose())
    await this.disposeQuietly('summaryContext', () => this.summaryContext?.dispose())
    await this.disposeQuietly('model', () => this.model?.dispose())
    this.contextSequence = undefined
    this.context = undefined
    this.summarySequence = undefined
    this.summaryContext = undefined
    this.model = undefined
    this.contextSize = undefined
    this.gpuLayersUsed = undefined
    this.gpuLayersTotal = undefined
  }

  private async disposeQuietly(label: string, dispose: () => unknown): Promise<void> {
    try {
      await dispose()
    } catch (error) {
      log.warn(`${label} dispose failed:`, error)
    }
  }

  private setState(
    patch: Partial<Pick<EngineState, 'status' | 'model' | 'error' | 'contextSize' | 'refusedLoad'>>
  ): void {
    if (patch.status !== undefined) this.status = patch.status
    if ('model' in patch) this.currentModel = patch.model
    if ('error' in patch) this.error = patch.error
    if (patch.contextSize !== undefined) this.contextSize = patch.contextSize
    // `in`, not `!== undefined`: clearing the record is the common case.
    if ('refusedLoad' in patch) this.refusedLoad = patch.refusedLoad
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

  for (const rawTurn of history) {
    const turn = sanitizeHistoryTurn(rawTurn)
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
        result: rememberToolCallForModel(call)
      })
    }
    response.push(turn.content)
    items.push({ type: 'model', response })
  }

  return items
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

/**
 * One line of the model's actual answer, with a reasoning model's scratchpad
 * dropped — both the tagged kind and the untagged narration that comes before
 * it. Returns nothing when narration is all there was.
 */
function answerLines(raw: string): string[] {
  return (
    raw
      .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
      // An unterminated block means the whole tail is reasoning.
      .replace(/<(?:think|thinking|reasoning)>[\s\S]*$/i, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  )
}

/**
 * The digest as it should appear on an inbox row, or null when the model gave
 * nothing usable.
 *
 * Null matters as much as the happy path here. This used to accept whatever
 * came back as long as it was non-empty, so a model that narrated instead of
 * answering — "Here's a thinking process: 1." — put that on the row. And since
 * the narration is generic, it put the *same* sentence on every row in the
 * inbox, which is a worse outcome than no digests at all: identical text on
 * twenty rows reads as a broken page rather than as a feature that didn't run.
 * Returning null instead leaves each row on its own snippet.
 *
 * What survives the guards is then trimmed to the one sentence the row has
 * space for. Small local models often answer a "one sentence" instruction with
 * a sentence plus a helpful second one, or wrap the whole thing in quotes;
 * rather than reject that as malformed — which would leave the row with no
 * digest at all — take the first sentence and let the rest go.
 */
export function cleanThreadDigest(raw: string): string | null {
  // No fallback to a rejected line, unlike `cleanChatTitle`: a row that has
  // narration on it is worse than a row that has its snippet on it, and the
  // snippet is always there.
  const line = answerLines(raw)
    .filter(
      (candidate) =>
        !REASONING_MONOLOGUE_RE.test(candidate) || isConcreteUserQuestionDigest(candidate)
    )
    .find(
      (candidate) =>
        !REASONING_PREAMBLE_RE.test(candidate) || isConcreteUserQuestionDigest(candidate)
    )
  if (!line) return null

  const cleaned = line
    .replace(/^["'“”\s]+|["'“”\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null

  const firstSentence = firstSentenceOf(cleaned).trim()
  const digest = firstSentence.length > 200 ? `${firstSentence.slice(0, 200)}…` : firstSentence

  // Too short to be a sentence about anything — a stray "1." or "Sure".
  if (digest.length < 12) return null
  return digest
}

/**
 * A Qwen email digest can accurately describe a question as "The user asks
 * if ...". The shared reasoning guards also match that prefix, because it is
 * common in model self-commentary. Keep this deliberately narrow exception:
 * a concrete indirect question has subject matter after it, while a prompt
 * echo such as "The user wants a one-sentence summary" remains rejected.
 */
function isConcreteUserQuestionDigest(candidate: string): boolean {
  return /^the user asks (?:if|whether|about)\b/i.test(candidate.trim())
}

function renderTitleContext(request: ChatTitleRequest): string {
  const userPrompt = truncateForTitlePrompt(
    request.userPrompt || request.attachmentNames?.join(', ') || ''
  )
  const assistantReply = truncateForTitlePrompt(request.assistantReply)
  const attachments = request.attachmentNames?.length
    ? `\nAttachments: ${request.attachmentNames.slice(0, 4).join(', ')}`
    : ''
  const editedFiles = request.editedFiles?.length
    ? `\nEdited files: ${request.editedFiles.slice(0, 6).join(', ')}`
    : ''

  return `<conversation>\nUser: ${userPrompt}\nAssistant: ${assistantReply}${attachments}${editedFiles}\n</conversation>`
}

function renderReplaySuggestionContext(request: ChatReplaySuggestionRequest): string {
  const userPrompt = truncateForTitlePrompt(request.userPrompt)
  const assistantReply = truncateForTitlePrompt(request.assistantReply)
  return `<completed_turn>\nUser request: ${userPrompt}\nAssistant reply: ${assistantReply}\n</completed_turn>`
}

function truncateForTitlePrompt(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length > 900 ? `${cleaned.slice(0, 900)}...` : cleaned
}

/**
 * Openers that a reasoning model uses to narrate, and that no plausible title
 * starts with. Deliberately conservative: only phrases that would be strange as
 * the first words of a title are listed, so a genuine title like "Plan Garden
 * Layout" or "First Draft Review" is never discarded.
 */
const REASONING_PREAMBLE_RE =
  /^(?:here(?:'s| is)\b|okay\b|ok[,\s]|alright\b|sure[,\s]|let(?:'s| me)\b|i(?:'ll| will| need to| should| can)\b|the user\b|we need\b|looking at\b|based on\b|to summari[sz]e\b|thinking process\b|thought process\b|step \d)/i

/**
 * Telltale fragments of the title-generation instruction itself (see the
 * prompt in `generateChatTitle`). Observed directly, reproduced twice: a
 * model echoing the instruction back ("Goal: Create a 3-6 word Title Case")
 * instead of following it. Rejecting these is safe — the caller falls back
 * to the already-reasonable derived title from the first message rather
 * than showing a title-less chat (see `generateConversationTitle` in
 * `chatStore.ts`, which no-ops on a `null` result).
 */
const INSTRUCTION_ECHO_RE =
  /\b(?:3[\s-]to[\s-]6|3-6)\s*words?\b|\btitle\s*case\b|\bconcise\s*title\b|\bno\s*preamble\b|\bno\s*trailing\s*punctuation\b/i

/**
 * Unmistakable reasoning monologue.
 *
 * Separate from `REASONING_PREAMBLE_RE` because the two answer different
 * questions. That one guesses from a line's *first words* and is allowed to be
 * wrong — "Sure Thing Bakery Website" trips it and is a perfectly good title,
 * which is why callers may fall back to a line it rejected. This one matches
 * on content that cannot appear in any real title or digest, so a match is
 * conclusive and the line is discarded outright.
 *
 * Every phrase here was observed on screen: a local Qwen3.6 titled a chat
 * "Here's a thinking pr…" and put "Here's a thinking process: 1." on all
 * twenty rows of an inbox, because the broad guard rejected the line and the
 * fallback then handed it back anyway.
 */
const REASONING_MONOLOGUE_RE =
  /\b(?:thinking|thought)\s+process\b|\blet me (?:think|start|begin|work)\b|\bthe user (?:wants|asked|asks|is asking|needs)\b|\bfirst,?\s+i\s+(?:need|should|will|must)\b|^\s*step\s*\d/i

/** Trailing tokens that end in a period without ending a sentence. */
const ABBREVIATION_RE =
  /(?:^|\s)(?:[A-Za-z]|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|No|Inc|Ltd|Co|approx|dept|fig)\.$/i

/**
 * The first sentence, rejoining splits that landed on an abbreviation.
 *
 * A plain split on "period then space" cuts "J. Okafor asks…" down to "J.",
 * which is how a digest for a real thread became two characters.
 */
function firstSentenceOf(text: string): string {
  const parts = text.split(/(?<=[.!?])\s+/)
  let sentence = parts[0] ?? text
  for (let index = 1; index < parts.length && ABBREVIATION_RE.test(sentence); index += 1) {
    sentence = `${sentence} ${parts[index]}`
  }
  return sentence
}

export function cleanChatTitle(raw: string): string | null {
  // Reasoning models emit their scratchpad before the answer. Taking the first
  // non-empty line therefore titled a real conversation "Here's a thinking
  // process" — observed directly with a Qwen3 local model. Drop the reasoning
  // block, then skip any remaining narration lines to reach the actual title.
  //
  // A line of outright monologue is dropped before the fallback can reach it.
  // That fallback is how "Here's a thinking pr…" ended up in the sidebar
  // despite the guard: a model that put its whole monologue on one line left
  // nothing for `find` to return, so the monologue was handed back anyway. It
  // still has to exist, though — the preamble guard is a first-words guess and
  // rejects real titles like "Sure Thing Bakery Website", which the fallback
  // is what rescues.
  const candidates = answerLines(raw).filter((line) => !REASONING_MONOLOGUE_RE.test(line))
  const firstLine = candidates.find((line) => !REASONING_PREAMBLE_RE.test(line)) ?? candidates[0]
  if (!firstLine) return null

  const cleaned = firstLine
    .replace(/^title\s*:\s*/i, '')
    // Wrapping markdown emphasis (**bold**, __bold__, *italic*) the model
    // sometimes adds around the title — observed directly ("**Fetch URL
    // Content**") — isn't part of the title itself.
    .replace(/^[*_]{1,3}|[*_]{1,3}$/g, '')
    .replace(/^["'\s]+|["'.!?:;\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned || cleaned.length < 3) return null
  if (INSTRUCTION_ECHO_RE.test(cleaned)) return null

  const words = cleaned.split(' ').slice(0, 7)
  return (
    words
      .join(' ')
      .slice(0, 60)
      .replace(/[,;:]+$/, '')
      .trim() || null
  )
}

/** Normalize a one-sentence composer suggestion and reject model narration or instruction echoes. */
export function cleanReplaySuggestion(raw: string): string | null {
  const candidate = answerLines(raw)
    .filter((line) => !REASONING_MONOLOGUE_RE.test(line))
    .find((line) => !REASONING_PREAMBLE_RE.test(line))
  if (!candidate) return null

  const cleaned = firstSentenceOf(candidate)
    .replace(/^suggestion\s*:\s*/i, '')
    .replace(/^[*_]{1,3}|[*_]{1,3}$/g, '')
    .replace(/^['"\s]+|['"\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned || /^(?:none|no(?:ne)? available)$/i.test(cleaned)) return null
  if (INSTRUCTION_ECHO_RE.test(cleaned) || REASONING_MONOLOGUE_RE.test(cleaned)) return null

  const words = cleaned.split(' ').slice(0, 16)
  const suggestion = words.join(' ').slice(0, 180).trim()
  return suggestion.length >= 6 ? suggestion : null
}

function defaultContextShiftReserve(contextSize: number): number {
  return Math.max(1, Math.floor(contextSize / 10))
}

function appendUserPrompt(
  history: readonly ChatHistoryItem[],
  prompt: string,
  append: LlamaModule['appendUserMessageToChatHistory']
): ChatHistoryItem[] {
  return append(history, prompt)
}

function appendModelResponse(history: readonly ChatHistoryItem[]): ChatHistoryItem[] {
  if (history.at(-1)?.type === 'model') return [...history]
  return [...history, { type: 'model', response: [] }]
}

function buildStats(tokens: number, startedAt: number): GenerationStats {
  const durationMs = Math.max(1, Date.now() - startedAt)
  return {
    tokens,
    durationMs,
    tokensPerSecond: Number((tokens / (durationMs / 1000)).toFixed(1))
  }
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
  const projectorBytes = info.visionProjectorSizeBytes ?? 0

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
    const required =
      (modelReq.cpuRam + contextReq.cpuRam + projectorBytes) * MIN_FREE_RAM_MULTIPLIER
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
    const totalModelBytes = info.sizeBytes + projectorBytes
    const required = totalModelBytes * MIN_FREE_RAM_MULTIPLIER
    if (free >= required) return null
    const freeGb = (free / 1024 ** 3).toFixed(1)
    const modelGb = (totalModelBytes / 1024 ** 3).toFixed(1)
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
function describeLoadError(error: unknown, info: ModelInfo, nativeLog: readonly string[]): string {
  const raw = error instanceof Error ? error.message : String(error)
  const base = raw || 'Failed to load model.'
  // A cause llama.cpp actually named beats the generic memory guidance below,
  // which is a guess — and a misleading one for a model that can never load on
  // this build no matter how much memory is free.
  const nativeCause = describeNativeLoadFailure(nativeLog) ?? describeUnreadableModelFile(raw)
  if (nativeCause) return `${base} ${nativeCause}`
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
