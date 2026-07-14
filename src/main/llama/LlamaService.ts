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
import type {
  ChatCompactRequest,
  ChatCompactResult,
  ChatHistoryTurn,
  ChatTitleRequest,
  GenerationOptions,
  GenerationStats,
  HistoryCompactionEvent
} from '@shared/chat.types'
import type { ConversationContext } from '@shared/context.types'
import type { EmailSettings, PermissionMode, WebSearchSettings } from '@shared/settings.types'
import type { ToolCall, ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import type { Plan } from '@shared/plan.types'
import { sanitizeHistoryTurn } from '@shared/chatSanitizer'
import { CONTEXT_SIZE_LADDER } from '@shared/contextSizes'
import { pickRecommendedContextSize } from '@shared/contextRecommendation'
import { planManualContextCompaction } from '@shared/contextProjection'
import type { ToolFunction } from '../tools/types'
import { buildTools } from '../tools/registry'
import { createLoopGuardState } from '../tools/loopGuard'
import {
  assembleModelContext,
  mergeContextSummaries,
  rememberToolCallForModel,
  seedContextFromSnapshot
} from './contextAssembler'
import {
  detectFabricatedUserTurn,
  detectFallbackToolCall,
  looksLikeFabricatedOutcome,
  looksLikeStalledIntent,
  looksLikeToolBypass,
  looksLikeUnactedIntent,
  stripFallbackCall,
  type FallbackToolCall
} from './toolCallFallback'
import { stripLeakedChannelTokens, stripSubstantialCodeFences } from '@shared/toolCallText'
import { modelReliabilityStore } from '../models/ModelReliabilityStore'
import { createLogger } from '../utils/logger'
import {
  buildCompactionSummaryPrompt,
  COMPACTION_TRIGGER_RATIO,
  MAX_COMPACTION_SUMMARY_WORDS,
  MIN_CHARS_TO_SUMMARIZE,
  MIN_SUMMARY_CHARS,
  NODE_LLAMA_CPP_CONTEXT_SHIFT_CRASH_FRAGMENT,
  renderTurnsForSummary
} from './compaction'

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
 * the function" in a turn with zero tool calls). Deliberately names no
 * specific tool — unlike the original version of this prompt, which said
 * "call write_file or edit_file", wrongly steering toward file-edit tools
 * even in a turn about a completely different tool (observed directly:
 * `propose_change`/`update_change_task`/`archive_change` narrated the same
 * way, where naming write_file/edit_file would have been actively wrong
 * guidance). One retry only; if it narrates again, that's treated as the
 * model's real answer rather than looped on indefinitely.
 */
const INTENT_NUDGE_PROMPT =
  'You described an outcome — a change, an approval, or a denial — that did not ' +
  'actually happen this turn; no tool was called. If you intend to make the change, ' +
  "call the appropriate tool now to do it for real. If you can't or the task " +
  "is blocked, say so plainly instead of describing something that didn't happen."

const TOOL_BYPASS_NUDGE_PROMPT =
  'You provided code or file-edit instructions in chat instead of applying the change. ' +
  'In this project chat, do not hand the user code to copy. Read the relevant file if ' +
  'needed, then call write_file, edit_file, or patch_file to make the change for real. ' +
  'If the user asked to see the result in chat, call preview_html on the relevant HTML file. ' +
  "If you cannot make the change, say exactly what's blocking you."

/**
 * Sent once, at most, when a reply just restates the request in collaborative
 * future-tense voice ("Sure, let's add...") without calling any tool at all
 * this turn (see `looksLikeStalledIntent` in `toolCallFallback.ts`). Distinct
 * from `INTENT_NUDGE_PROMPT`: that covers a false *past-tense* completion
 * claim; this covers the model never even attempting anything. Deliberately
 * generic — unlike the other nudges, it doesn't name specific tools, since
 * this pattern isn't limited to edit tools (observed with git_status too,
 * not just write_file/edit_file) and can fire in chats where the available
 * tool for the job isn't a file-edit tool at all.
 */
const STALLED_INTENT_NUDGE_PROMPT =
  'You described what you were about to do but did not actually call any tool this turn — ' +
  'nothing happened yet. Stop describing the plan and call the appropriate tool now to do the ' +
  "work for real. If you can't or the task is blocked, say so plainly instead of restating the plan."

/** The dynamically-imported `node-llama-cpp` module (ESM-only). */
type LlamaModule = typeof import('node-llama-cpp')

/**
 * Thrown by `generate()` when the single shared local engine is already busy
 * with an unrelated generation (e.g. an interactive chat) — exported so
 * callers like `AgentRunService` can recognize this specific, recoverable
 * contention case rather than treating it as a genuine run failure.
 */
export const GENERATION_IN_PROGRESS_ERROR = 'A response is already being generated.'

export interface GenerateParams {
  conversationId: string
  /** Assistant message id, used to route tool activity to the right turn. */
  messageId: string
  systemPrompt?: string
  /** Persisted context snapshot for older turns, when one exists. */
  context?: ConversationContext | null
  history: ChatHistoryTurn[]
  prompt: string
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
  signal?: AbortSignal
  /** When present, the model is given tools for this generation. */
  tools?: {
    /** Workspace folder for file/command tools, or null for web-only tools. */
    workspaceRoot: string | null
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
    /** Restricts which tools get registered at all; null = unrestricted (normal chat). */
    enabledTools?: Set<string> | null
    onActivity: (call: ToolCall) => void
    confirm: (request: ToolConfirmRequest) => Promise<ToolConfirmResponse>
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
   * `LOOP_GUARD_ABORT_AFTER` in `loopGuard.ts`). Undefined for every other
   * stop path (fabricated-turn detection, context-shift recovery, or a
   * provider — Anthropic/OpenAI — that doesn't distinguish reasons at all).
   * Callers that don't care can ignore this and treat any `stopped: true`
   * the same as before; `AgentRunService` uses it specifically to tell "the
   * user wants everything to stop" apart from "this one turn looped" —
   * only the former should end a whole multi-turn run.
   */
  stopReason?: 'user' | 'loop-guard'
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

  /**
   * Approximate "input tokens" for a turn — tokenizes only the new prompt
   * text, not the full conversation history/system prompt. Anodex's local
   * engine reuses the KV cache turn-over-turn rather than rebilling the full
   * context like a cloud API, so there's no equivalent of a real "prompt
   * tokens" figure; this is a pragmatic proxy for how much new text the user
   * contributed this turn, used only for the token-activity usage stats.
   */
  countPromptTokens(prompt: string): number {
    if (!this.model) return 0
    return this.model.tokenize(prompt).length
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
      throw new Error(GENERATION_IN_PROGRESS_ERROR)
    }

    // Take the lock before any awaited setup touches the shared context/session.
    // `ensureSession()` can clear and rebuild the native KV cache, so this
    // pre-generation work must be covered by the same single-generation guard
    // as the decode loop itself.
    this.generating = true
    this.emitState()

    let session: LlamaChatSession
    try {
      session = await this.ensureSession(
        params.conversationId,
        params.systemPrompt,
        params.history,
        params.context
      )
    } catch (error) {
      this.generating = false
      this.emitState()
      throw error
    }

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
      try {
        session = await this.recompactSession(params, 'proactive')
      } catch (error) {
        this.generating = false
        this.emitState()
        throw error
      }
    }

    let hadSuccessfulWrite = false
    // Any tool activity at all this turn (attempted, denied, errored, or
    // succeeded) — narrower than `hadSuccessfulWrite`, used to gate the
    // fabricated-outcome check below, which must not fire when a real
    // interaction actually happened this turn.
    let hadAnyToolAttempt = false
    const currentModel = this.currentModel
    let functions: Record<string, ToolFunction> | undefined
    // Filled in below once `genController` exists — see `buildToolFunctions`'s
    // doc comment for why this can't just be passed in directly.
    const abortBox: { current: (() => void) | null } = { current: null }
    try {
      functions = await this.buildToolFunctions(
        params,
        (call) => {
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
        },
        abortBox
      )
    } catch (error) {
      this.generating = false
      this.emitState()
      throw error
    }
    const startedAt = Date.now()
    let visibleContent = ''
    let tokenCount = 0
    let stopped = false
    // Set only by the loop guard's abort (see `abortBox` below) — distinct
    // from `genController.signal.aborted`, which also goes true on a plain
    // user stop (forwarded into it) or the pre-existing fabricated-turn
    // abort, neither of which should get the loop-guard-specific stopReason.
    let loopGuardAborted = false
    let usedIntentNudge = false
    const originalPrompt = params.prompt
    let prompt = params.prompt
    // The nudge prompts fired below explicitly instruct the model to call
    // write_file/edit_file/patch_file — only meaningful if one of those is
    // actually registered for this chat (e.g. no project workspace is open,
    // so only web tools are active). `functions` is fixed for the whole
    // turn, so this only needs computing once, not once per round.
    const hasEditTool = Boolean(
      functions &&
      ('write_file' in functions || 'edit_file' in functions || 'patch_file' in functions)
    )

    // Guard abort we trigger ourselves the moment the model starts fabricating
    // the user's next turn mid-generation (see `detectFabricatedUserTurn`) — so
    // generation stops *before* any tool call in that invented turn actually
    // runs, rather than only cleaning up the transcript after the fact. Merged
    // with the caller's own signal so a real user "stop" still aborts too.
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
    // A real user stop takes priority in the reported reason even if the
    // loop guard also fired around the same moment — vanishingly unlikely,
    // but "the user asked to stop" is the more actionable thing to report.
    const currentStopReason = (): GenerateOutcome['stopReason'] => {
      if (params.signal?.aborted) return 'user'
      if (loopGuardAborted) return 'loop-guard'
      return undefined
    }
    // Index within the current round's content where a fabricated user turn
    // begins, once detected — everything from here on is dropped.
    let fabricatedTurnCut: number | null = null
    const finalizeFabricatedTurn = (keptContent: string): void => {
      visibleContent = appendContent(visibleContent, keptContent.trimEnd())
      stopped = true
      if (currentModel) {
        modelReliabilityStore.recordFabrication(
          currentModel.id,
          currentModel.name,
          basename(currentModel.path)
        )
      }
    }

    try {
      for (let round = 0; ; round++) {
        let roundContent = ''
        let roundSegment = ''
        const promptOptions = {
          temperature: params.options?.temperature,
          topP: params.options?.topP,
          maxTokens: params.options?.maxTokens,
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
          signal: genController.signal,
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
            // Only meaningful when tools are registered: the danger of a
            // fabricated user turn is the model acting on its own invented
            // approval. Detecting here, as the fabricated reply streams in but
            // before the model emits its next tool-call token, lets the abort
            // below stop the round before that call ever executes.
            if (fabricatedTurnCut === null && functions) {
              const cut = detectFabricatedUserTurn(roundContent)
              if (cut !== -1) {
                fabricatedTurnCut = cut
                genController.abort()
              }
            }
          }
        }

        // Reactive safety net: node-llama-cpp's own built-in context-shift
        // strategy can still fail mid-generation (e.g. a single turn's tool
        // results grow the KV cache past the proactive check above before the
        // next turn gets a chance to compact). Recompacting rebuilds the
        // session from `params.history` — this turn's own earlier rounds
        // (tool calls/results already produced by round 1+) live only in local
        // variables here and are NOT in `params.history` yet, so recompacting
        // would silently discard them. Only safe on round 0, before this turn
        // has done anything of its own; round 1+ and any round that already
        // streamed content instead surfaces an honest error/partial-stop
        // rather than silently losing already-completed tool work.
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
          meta = await session.promptWithMeta(prompt, promptOptions)
        } catch (error) {
          // Our own guard fired mid-stream (not a failure): the model began
          // fabricating the user's next turn. Keep the reply up to the cut
          // point (the genuine question), drop the invented turn, and end the
          // turn so control returns to the real user. Checked before the
          // context-shift handling below because this abort is expected, not an
          // error to recover from.
          if (fabricatedTurnCut !== null) {
            finalizeFabricatedTurn(roundContent.slice(0, fabricatedTurnCut))
            break
          }
          const isContextShiftFailure =
            error instanceof Error &&
            error.message.includes(NODE_LLAMA_CPP_CONTEXT_SHIFT_CRASH_FRAGMENT)
          if (
            !isContextShiftFailure ||
            round > 0 ||
            roundContent.length > 0 ||
            roundSegment.length > 0
          ) {
            throw error
          }
          log.warn('Context shift failed mid-generation; compacting and retrying this round once.')
          session = await this.recompactSession(params, 'reactive')
          meta = await session.promptWithMeta(prompt, promptOptions)
        }

        // Aborting mid-stream can also resolve (rather than throw) with the
        // partial text already streamed — handle the fabricated-turn cut here
        // too, before `meta.responseText` (the full, untruncated text) replaces
        // the streamed `roundContent` below.
        if (fabricatedTurnCut !== null) {
          finalizeFabricatedTurn(roundContent.slice(0, fabricatedTurnCut))
          break
        }

        // Prefer the assembled final text, then fall back to streamed text.
        roundContent = meta.responseText || roundContent
        // Some reasoning/think-tagged models emit only thought segments with no
        // visible answer. Surface those instead of an empty bubble.
        if (!roundContent.trim() && roundSegment.trim()) {
          roundContent = roundSegment.trim()
        }
        // A chat template's own hidden-reasoning boundary marker (e.g.
        // Gemma4ChatWrapper's `<channel|>`) that a model didn't reproduce
        // precisely enough for the wrapper to consume internally — falls
        // through as literal text otherwise. Cleaned here, before any of the
        // detection logic below sees it, so a stray leaked tag can't also
        // confuse the fallback/stalled-intent checks.
        roundContent = stripLeakedChannelTokens(roundContent)

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
          // The reply describes an outcome that didn't actually happen this turn:
          // either a claimed file change with no successful write anywhere this
          // turn, a code-dump bypass of available edit tools, a fabricated
          // approval/denial/test-result when no tool was called at all this turn,
          // or — distinct from all three — a bare announcement of intent with no
          // tool call attempted at all (see `looksLikeStalledIntent`). This
          // detection is independent of tool availability — a model can
          // fabricate an outcome (or stall) for remember_fact or git_status just
          // as easily as for a file edit — so it is NOT gated on hasEditTool.
          const isToolBypass =
            Boolean(activeFunctions) &&
            !hadSuccessfulWrite &&
            looksLikeToolBypass(roundContent, originalPrompt)
          const isStalledIntent =
            !hadAnyToolAttempt && looksLikeStalledIntent(roundContent, originalPrompt)
          const isFabrication =
            Boolean(activeFunctions) &&
            (isToolBypass ||
              (!hadSuccessfulWrite && looksLikeUnactedIntent(roundContent)) ||
              (!hadAnyToolAttempt && looksLikeFabricatedOutcome(roundContent)) ||
              isStalledIntent)

          // Record this independently of whether a nudge fires below: a bypass,
          // fabricated outcome, or stall still tells us the model needs more
          // steering, even when the one-nudge-per-turn budget was already
          // spent, or when no edit tool is registered to nudge toward.
          if (isFabrication && currentModel) {
            modelReliabilityStore.recordFabrication(
              currentModel.id,
              currentModel.name,
              basename(currentModel.path)
            )
          }

          // The bypass nudge explicitly instructs the model to call
          // write_file/edit_file/patch_file by name, so it only fires when
          // one of those tools is actually registered for this chat — it's
          // specifically about dumping code in chat instead of using an edit
          // tool, which only makes sense when an edit tool exists. The
          // unacted-intent/fabricated-outcome and stalled-intent nudges are
          // both generic — neither names a specific tool — so they can fire
          // whenever any tool at all is available: a false completion claim
          // or a stall isn't limited to edit tools (observed directly with
          // propose_change/update_change_task/archive_change, not just
          // write_file/edit_file).
          const needsToolBypassNudge = isToolBypass && hasEditTool
          const needsUnactedIntentNudge =
            (!hadSuccessfulWrite && looksLikeUnactedIntent(roundContent)) ||
            (!hadAnyToolAttempt && looksLikeFabricatedOutcome(roundContent))
          const needsGenericNudge =
            (needsUnactedIntentNudge || isStalledIntent) && Boolean(activeFunctions)
          const needsActionNudge = needsToolBypassNudge || needsGenericNudge

          // Content the model already produced this round is never silently
          // dropped, even when nudging for a retry — a false-positive nudge
          // (or one the model doesn't repeat next round) would otherwise
          // erase the round from the transcript with no trace anywhere. What
          // IS stripped: a substantial file-edit code fence, when an edit tool
          // exists to have done the work for real — the tool card (if any
          // write succeeded) or the upcoming nudge (if not) already covers
          // it, so repeating the whole file as prose is just noise. Skipped
          // entirely in a tool-less chat, where a code paste may be the
          // model's only possible answer.
          const displayRoundContent = hasEditTool
            ? stripSubstantialCodeFences(roundContent, originalPrompt)
            : roundContent
          visibleContent = appendContent(visibleContent, displayRoundContent)

          // Give it one chance to actually act.
          if (needsActionNudge && !usedIntentNudge) {
            usedIntentNudge = true
            prompt = needsToolBypassNudge
              ? TOOL_BYPASS_NUDGE_PROMPT
              : needsUnactedIntentNudge
                ? INTENT_NUDGE_PROMPT
                : STALLED_INTENT_NUDGE_PROMPT
            continue
          }
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
        visibleContent = appendContent(visibleContent, cleanedRoundContent)

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
        stopped,
        stopReason: stopped ? currentStopReason() : undefined
      }
    } catch (error) {
      // `genController` also gets aborted internally by the loop guard (see
      // `checkLoopGuard`/`abortBox` above), not just by `params.signal` — if
      // `promptWithMeta` throws instead of resolving with `stopReason:
      // 'abort'` for that case, this still ends the turn cleanly with
      // whatever content was already produced, matching the graceful path
      // below rather than surfacing a confusing raw abort error.
      if (params.signal?.aborted || genController.signal.aborted) {
        log.info('Generation stopped (user or loop guard)')
        return {
          content: visibleContent,
          stats: buildStats(tokenCount, startedAt),
          stopped: true,
          stopReason: currentStopReason()
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
      if (
        error instanceof Error &&
        error.message.includes(NODE_LLAMA_CPP_CONTEXT_SHIFT_CRASH_FRAGMENT)
      ) {
        log.warn('Context shift failed mid-turn; ending this turn early with partial content.')
        this.disposeSession()
        return { content: visibleContent, stats: buildStats(tokenCount, startedAt), stopped: true }
      }
      throw error
    } finally {
      params.signal?.removeEventListener('abort', forwardAbort)
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
      const sequence = await this.ensureSummarySequence(1024)
      const truncated = text.length > 1200 ? `${text.slice(0, 1200)}…` : text
      const finalText = await this.runSummaryPrompt(
        sequence,
        `Summarize the following in ${maxWords} words or fewer. Reply with only the ` +
          `summary itself — no quotes, no trailing punctuation, no preamble.\n\n${truncated}`,
        {
          // Generous relative to the target word count — leaves room for a
          // model that still reasons a little before answering, without
          // letting it ramble on at length for what's just a toast title.
          maxTokens: Math.max(64, maxWords * 4),
          temperature: 0.2
        }
      )
      return cleanToastSummary(finalText, maxWords)
    } catch (error) {
      log.warn('Toast summary generation failed:', error)
      return null
    }
  }

  /** Best-effort short title for a new conversation, based on the first completed turn. */
  async generateChatTitle(request: ChatTitleRequest): Promise<string | null> {
    if (this.status !== 'ready' || !this.model) return null

    try {
      const sequence = await this.ensureSummarySequence(1536)
      const context = renderTitleContext(request)
      const finalText = await this.runSummaryPrompt(
        sequence,
        'Create a concise title for this AI assistant conversation. The title should describe ' +
          'the actual task or topic, not copy the first words verbatim. Use 3 to 6 words, ' +
          'Title Case, no quotes, no trailing punctuation, no preamble. Prefer an action plus ' +
          `object, such as "Fix Sidebar Hover Preview" or "Plan Garden Layout".\n\n${context}`,
        { maxTokens: 64, temperature: 0.15 }
      )
      return cleanChatTitle(finalText)
    } catch (error) {
      log.warn('Chat title generation failed:', error)
      return null
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
    if (this.status !== 'ready' || !this.model) {
      throw new Error('No model is loaded. Load a model before compacting chat context.')
    }

    const plan = planManualContextCompaction(request.history, request.context)
    if (!plan) return null

    const transcript = renderTurnsForSummary(plan.older)
    if (transcript.length < MIN_CHARS_TO_SUMMARIZE) return null

    const summary = await this.summarizeHistoryForCompaction(transcript)
    if (!summary) return null

    return {
      conversationId: request.conversationId,
      compactedTurns: plan.compactedTurns,
      snapshot: {
        createdAt: Date.now(),
        reason: 'manual',
        throughMessageId: plan.compactedThroughMessageId,
        removedTurns: plan.previousRemovedTurns + plan.compactedTurns,
        summary: mergeContextSummaries(plan.previousSummary, summary) ?? summary
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
    let session = new nlc.LlamaChatSession({ contextSequence: sequence })
    // Qwen 3's chat template defaults to "thinking" mode — we want a direct
    // answer, not a reasoning monologue, so explicitly discourage it when
    // that's the resolved wrapper. Verified directly: without this,
    // `session.prompt()` returned an empty string because the whole reply
    // went into the (unsurfaced) thinking segment.
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
        onResponseChunk: (chunk) => {
          if (chunk.type === 'segment') segmentText += chunk.text
          else responseText += chunk.text
        }
      })
      const finalText = meta.responseText || responseText || segmentText
      // These throwaway summarization sessions use the same chat wrappers
      // (e.g. Gemma4ChatWrapper) as the main conversation, so they're subject
      // to the same special-token leak (see `stripLeakedChannelTokens`'s
      // docs). Compaction summaries in particular are now shown directly to
      // the user via the in-transcript compaction marker, not just fed back
      // as model context, so a leaked `<channel|>` here would be a new
      // user-visible bug rather than a harmless internal artifact.
      return stripLeakedChannelTokens(finalText)
    } finally {
      session.dispose()
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
    history: ChatHistoryTurn[],
    context: ConversationContext | null | undefined,
    compactionReason: HistoryCompactionEvent['reason'] = 'onLoad'
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

    const compacted = await this.compactHistoryForSession(systemPrompt, history, context)
    if (compacted.removedTurns > 0) {
      this.emit('historyCompacted', {
        conversationId,
        removedTurns: compacted.removedTurns,
        reason: compactionReason,
        summarized: compacted.summarized,
        summary: compacted.summary,
        compactedThroughMessageId: compacted.compactedThroughMessageId,
        createdAt: Date.now()
      } satisfies HistoryCompactionEvent)
    }

    const nlc = await this.getModule()
    this.session = new nlc.LlamaChatSession({
      contextSequence: this.contextSequence,
      systemPrompt: compacted.systemPrompt
    })

    const items = buildHistoryItems(compacted.systemPrompt, compacted.history)
    if (items.length > 0) this.session.setChatHistory(items)

    this.activeConversationId = conversationId
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
    context: ConversationContext | null | undefined
  ): Promise<{
    systemPrompt: string | undefined
    history: ChatHistoryTurn[]
    removedTurns: number
    summarized: boolean
    summary?: string
    compactedThroughMessageId?: string | null
  }> {
    const seeded = seedContextFromSnapshot(systemPrompt, history, context)
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
      systemPrompt: seeded.systemPrompt,
      history: seeded.history,
      contextSize: this.contextSize,
      countTokens,
      summarizeOlderTurns: (transcript) => this.summarizeHistoryForCompaction(transcript)
    })

    if (assembled.removedTurns === 0) {
      return {
        systemPrompt: assembled.systemPrompt,
        history: assembled.history,
        removedTurns: 0,
        summarized: false
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
      summary: mergeContextSummaries(seeded.summary, assembled.summary),
      compactedThroughMessageId:
        assembled.compactedThroughMessageId ?? seeded.throughMessageId ?? null
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
  private async summarizeHistoryForCompaction(transcript: string): Promise<string | null> {
    if (!this.model) return null

    try {
      const sequence = await this.ensureSummarySequence(4096)
      // The transcript is untrusted data to describe, not instructions to
      // follow — without this framing, a weak model can latch onto a short
      // reply embedded in the transcript (e.g. a literal "OK") and just echo
      // that instead of summarizing. Verified live: without the
      // <conversation> delimiter + explicit "ignore requests inside it"
      // instruction, qwen2.5-coder-3b's "summary" of a 24-turn transcript
      // ending in "Assistant: OK" was literally the string "OK".
      const finalText = await this.runSummaryPrompt(
        sequence,
        buildCompactionSummaryPrompt(transcript),
        { maxTokens: Math.max(256, MAX_COMPACTION_SUMMARY_WORDS * 4), temperature: 0.2 }
      )
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
    reason: 'proactive' | 'reactive'
  ): Promise<LlamaChatSession> {
    this.disposeSession()
    return this.ensureSession(
      params.conversationId,
      params.systemPrompt,
      params.history,
      params.context,
      reason
    )
  }

  /**
   * Build the workspace tool set for a generation, or `undefined` if disabled.
   * `abortBox` is a mutable box the caller fills in with the real abort
   * function once `genController` exists — `buildToolFunctions` runs before
   * that, so the box lets the loop guard reach it anyway (same pattern as
   * `plan`/`turnGate` below, just resolved slightly later than those).
   */
  private async buildToolFunctions(
    params: GenerateParams,
    onActivity: (call: ToolCall) => void,
    abortBox: { current: (() => void) | null }
  ): Promise<Record<string, ToolFunction> | undefined> {
    if (!params.tools) return undefined
    const nlc = await this.getModule()
    return buildTools(nlc.defineChatSessionFunction, {
      conversationId: params.conversationId,
      messageId: params.messageId,
      workspaceRoot: params.tools.workspaceRoot,
      projectId: params.tools.projectId,
      permissionMode: params.tools.permissionMode,
      commandShell: params.tools.commandShell,
      webSearch: params.tools.webSearch,
      email: params.tools.email,
      memory: params.tools.memory,
      enabledTools: params.tools.enabledTools ?? null,
      // A mutable box, not the plan value itself — shared by every tool call
      // in this generation so `update_plan_step` sees `write_plan`'s result
      // within the same turn (see `ToolRuntimeContext.plan`'s doc comment).
      plan: { current: params.tools.plan },
      // Fresh every generation call, no seeding needed (unlike `plan`) — see
      // `ToolRuntimeContext.turnGate`'s doc comment.
      turnGate: { approved: false },
      // Fresh every generation call, same reasoning as `turnGate` above — see
      // `ToolRuntimeContext.loopGuard`'s doc comment.
      loopGuard: createLoopGuardState(),
      // See `ToolRuntimeContext.abortGeneration`'s doc comment and this
      // method's own doc comment above for why this goes through a box.
      abortGeneration: () => abortBox.current?.(),
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

function truncateForTitlePrompt(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length > 900 ? `${cleaned.slice(0, 900)}...` : cleaned
}

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

export function cleanChatTitle(raw: string): string | null {
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
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
