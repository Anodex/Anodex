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
import { APPROX_CHARS_PER_TOKEN } from '@shared/contextProjection'
import { projectHistoryForModel, rememberToolCallForModel } from './contextAssembler'
import { buildTools } from '../tools/registry'
import type { DefineChatSessionFunction, ToolFunction } from '../tools/types'
import { createLoopGuardState } from '../tools/loopGuard'
import { createReadCoverageTracker } from '../tools/readCoverage'
import { createLogger } from '../utils/logger'
import { toStopDetail } from '@shared/stopDetail'
import { appendRoundText } from '@shared/roundText'
import { LlamaServerRuntime } from './LlamaServerRuntime'
import { resolveLocalOutputBudget } from './localOutputBudget'
import { DIRECT_ANSWER_TEMPLATE_KWARGS } from './directAnswer'
import { isDroppedStreamError } from './droppedStreamError'
import {
  isTruncatedToolCallError,
  truncatedArgumentsLength,
  truncatedArgumentsPreview
} from './truncatedToolCallError'
import { boundToolSurface, type BoundedToolSurface } from './toolSurface'
import { toolParameterSchema } from '../tools/toolParameterSchema'
import {
  computeModelToolResultBudget,
  type ModelToolResultBudget
} from '../tools/modelResultBudget'
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
 * Floor on how long a round that produced a truncated tool call must have
 * taken to be a real generation.
 *
 * A cut-off call carries thousands of characters of arguments; even a fast GPU
 * needs seconds to decode that, and the local models this transport serves
 * take far longer. Observed live: after one genuine 58-second truncation, the
 * next two requests returned the same parse failure in 23 ms and 16 ms —
 * far too fast to have decoded anything, so the runtime was answering without
 * running the model. Retrying that cannot succeed, and spending the recovery
 * budget on it ends the turn on advice about request size that the timing
 * already disproves.
 */
const MIN_PLAUSIBLE_GENERATION_MS = 1_500
/**
 * Cap on rounds recovered by parsing a tool call the model wrote as prose.
 * Same value and same reasoning as the text path's `MAX_FALLBACK_ROUNDS`.
 */
const MAX_FALLBACK_ROUNDS = 8
/**
 * Per-message cost of the chat template's own framing — the role header, the
 * separators, and the end-of-turn token that llama-server renders around every
 * message but `/tokenize` never sees, because it is handed raw text.
 *
 * Small per message and irrelevant on a short exchange; on a tool-heavy turn
 * that has accumulated dozens of call/result pairs it is hundreds of tokens of
 * pure under-count, all of it in the direction that overflows the context.
 */
export const MESSAGE_FRAMING_TOKENS = 4
/**
 * Rough per-tool cost of one rendered OpenAI-style function schema.
 *
 * Shared by the two places that must guess at a schema surface rather than
 * measure one: `estimatedInput` (when the runtime has no `/tokenize`) and
 * `visionToolSchemaReserveTokens` (before this turn's surface has been built).
 */
const ESTIMATED_TOOL_SCHEMA_TOKENS = 140
/** Native schemas `boundToolSurface` always adds for the deferred-tool gateway. */
const GATEWAY_TOOL_COUNT = 3
/**
 * Assumed prompt cost of one image after the projector.
 *
 * `/tokenize` accepts text only, so there is no way to measure this exactly and
 * no single right answer: it varies by projector and, on dynamic-resolution
 * models, by the image itself. Deliberately set on the high side. Over-charging
 * costs some output headroom on an image turn; under-charging lets the real
 * prompt run past the context end mid-tool-call, which is the failure this
 * whole accounting path exists to prevent.
 */
const IMAGE_TOKEN_ESTIMATE = 768
/**
 * Output room below which a round is not worth sending.
 *
 * Matches `MIN_FUNCTION_OUTPUT_TOKENS` in `localOutputBudget.ts`: that module
 * refuses to clamp a tool-enabled turn below this because anything less cannot
 * hold a usable call, and the same threshold decides here whether there is
 * still a turn to run at all.
 */
const MIN_VIABLE_OUTPUT_TOKENS = 512
/**
 * Most recent tool results left untouched when reclaiming in-turn room. The
 * model is actively reasoning from these; the older ones it has already acted
 * on, which is what makes them the right thing to shed first.
 */
const PROTECTED_RECENT_TOOL_RESULTS = 2
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
 * - `systemTokens` covers the system message *and* replayed history — including
 *   the arguments of every tool call made so far this turn. This transport
 *   re-sends the entire conversation every round (there is no KV-cache session
 *   to inherit it), so all of that is genuinely fixed input for the turn rather
 *   than something a context-shift strategy can evict.
 * - What `/tokenize` structurally cannot measure — the chat template's
 *   per-message framing and the projector's per-image embedding cost — is
 *   *added* as an estimate rather than omitted. Omitting it under-counts, and
 *   an under-count is not the safe direction: it inflates the output ceiling
 *   until the real prompt runs past the end of the context mid-tool-call, which
 *   llama-server surfaces as an unrecoverable 500 from its own argument parse.
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
    // Recomputed from this round's real measurement below, exactly as the text
    // path does (`LlamaService.generateInternal`). Left at `null` — as this
    // transport used to leave it permanently — every tool result falls back to
    // a static character cap that knows nothing about how much of a 16K context
    // is already spent, so one `read_file` late in a turn can claim room the
    // reply needed.
    const modelResultBudgetBox: { current: ModelToolResultBudget | null } = { current: null }
    const allToolFunctions = params.tools
      ? this.buildToolFunctions(params, visualInputs, modelResultBudgetBox, (call) => {
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
    /** The current round's visible text; see the fold at the top of the loop. */
    let roundContent = ''
    let thinking = ''
    let outputTokens = 0
    let stopped = false
    let tokenLimit = false
    let roundsExhausted = false
    /** Set when the recovery budget for cut-off tool calls ran out. */
    let toolCallsTruncated = false
    /** Set when the runtime failed a tool-call parse without having generated. */
    let staleParseFailure = false
    /** Set when a round failed outright after earlier ones had produced work. */
    let providerError: string | null = null
    /**
     * Set when the turn ran out of room for a usable reply before sending one:
     * `'fixed'` if the turn's own fixed input never fit, `'in-turn'` if this
     * turn's accumulated tool traffic consumed the window.
     */
    let contextExhausted: 'fixed' | 'in-turn' | null = null

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
      const inputLimitTokens = Math.max(0, this.contextSize - RESERVED_TOKENS)
      // Nothing else bounds growth *within* a turn. History is compacted once,
      // upstream, before the first round; from there every call and every
      // result is appended and never removed, so a long tool-using turn walks
      // steadily toward the context end. Reclaim room from the results the
      // model has already acted on before the prompt gets there, rather than
      // letting llama-server truncate the prompt out from under a tool call.
      //
      // Graduated, and stopping at the first tier that fits: shedding a result
      // the model may still need is a real cost, so it is paid in the smallest
      // increment that buys room, matching how `contextAssembler`'s
      // `truncateToolText` bounds remembered output rather than dropping it.
      const fitsNow = (input: MeasuredInput | null): boolean =>
        input === null || inputLimitTokens - input.fixedTokens >= MIN_VIABLE_OUTPUT_TOKENS
      if (!fitsNow(measured)) {
        const fixedTokensBefore = measured?.fixedTokens
        for (const tier of RECLAIM_TIERS) {
          if (reclaimToolResultRoom(messages, tier) === 0) continue
          measured = await this.measureInput(messages, tools, params.prompt)
          if (fitsNow(measured)) break
        }
        if (measured?.fixedTokens !== fixedTokensBefore) {
          log.info('Reclaimed in-turn room from earlier tool results', {
            round,
            fixedTokensBefore,
            fixedTokensAfter: measured?.fixedTokens
          })
        }
      }
      // Sending a request the prompt has already outgrown cannot produce a
      // usable reply: llama-server truncates the prompt to fit, cuts the model
      // off part-way through whatever it was emitting, and 500s on its own
      // parse of the half-written call. Ending here instead keeps the text and
      // completed tool work from the rounds that did fit.
      if (measured && inputLimitTokens - measured.fixedTokens < MIN_VIABLE_OUTPUT_TOKENS) {
        // Two different faults, and conflating them sends the user after the
        // wrong thing. On the first round nothing has accumulated yet, so the
        // *fixed* input — system prompt, project rules, tool schemas — is what
        // does not fit, and no amount of continuing helps; that is exactly what
        // `fixed-context-limit` reports, and it is deliberately not a
        // recoverable stop. Later rounds ran out because this turn's own tool
        // traffic filled the window, which a fresh cycle over compacted history
        // genuinely can carry on from.
        contextExhausted = round === 0 ? 'fixed' : 'in-turn'
        log.warn('Stopping the turn: no room left for a usable reply', {
          round,
          fixedTokens: measured.fixedTokens,
          inputLimitTokens
        })
        break
      }
      // The reply ceiling is the single most common cause of a tool call that
      // never finished emitting, and it is assembled from three places (the
      // user's setting, this turn's measured room, and a hard default). Log
      // all of them so a truncation can be attributed without guesswork.
      log.debug('Vision round budget', {
        round,
        requestedMaxTokens,
        fixedTokens: measured?.fixedTokens ?? null,
        contextSize: this.contextSize
      })
      if (measured) {
        // Tool results run through the same measured accounting the reply does,
        // so a result landing late in a turn can't claim the room the reply
        // needs. Recomputed every round because `fixedTokens` only grows.
        modelResultBudgetBox.current = computeModelToolResultBudget({
          contextSizeTokens: this.contextSize,
          inputLimitTokens,
          fixedTokens: measured.fixedTokens
        })
        const budget = resolveLocalOutputBudget({
          contextSize: this.contextSize,
          inputLimitTokens,
          fixedTokens: measured.fixedTokens,
          requestedMaxTokens,
          hasFunctions: toolFunctions != null
        })
        effectiveMaxTokens = budget.effectiveMaxTokens
        log.debug('Vision round output ceiling', { round, effectiveMaxTokens })
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

      // Folded into `content` at the top of the next round and once after the
      // loop, so narration before a tool call does not run into the answer
      // after it — and so every `break` path keeps the round it was in.
      content = appendRoundText(content, roundContent)
      roundContent = ''
      let roundThinking = ''
      let finishReason: string | null = null
      const roundStartedAt = Date.now()
      // llama-server prints its own per-request accounting (`launch_slot_`,
      // `print_timing`, `release`) as it works. Captured here so a failure can
      // be checked against whether the process did anything at all — see the
      // stale-parse branch below, where that is the difference between a
      // runtime fault and a genuine truncation.
      const runtimeOutputBefore = this.runtime.recentOutput()
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
        // Folded before anything below reads `content`. While streaming wrote
        // straight into `content`, a round that produced text before failing
        // was self-evidently worth keeping; once the fold moved to the round
        // boundary, a round-0 failure left `content` empty and the guard below
        // threw away text the user had already watched arrive. The three cloud
        // transports fold in their own catch for exactly this reason.
        content = appendRoundText(content, roundContent)
        roundContent = ''
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
          const roundMs = Date.now() - roundStartedAt
          const preview = truncatedArgumentsPreview(error)
          const argumentsChars = truncatedArgumentsLength(error)
          // A failure that comes back faster than the model could have decoded
          // anything *may* mean the runtime replayed a stale parse instead of
          // running at all — retrying that has no chance of succeeding, and
          // would only spend the budget and end on a message blaming the
          // request's size.
          //
          // Timing alone does not establish it, though. A call cut off almost
          // immediately — because the prompt left only a handful of tokens —
          // fails just as fast while being entirely genuine, and treating that
          // as a runtime fault turns a recoverable round into a dead turn with
          // misleading advice. So the timing only opens the question, and
          // llama-server's own output settles it: a process that really ran the
          // model prints new per-request accounting, and one replaying a cached
          // error prints nothing.
          const runtimeOutputAfter = this.runtime.recentOutput()
          if (roundMs < MIN_PLAUSIBLE_GENERATION_MS && runtimeOutputAfter === runtimeOutputBefore) {
            staleParseFailure = true
            log.error('llama-server returned a tool-call parse failure without generating', {
              roundMs,
              round,
              argumentsChars,
              preview,
              runtimeOutput: runtimeOutputAfter
            })
            break
          }
          if (toolCallRecoveries >= MAX_TOOL_CALL_RECOVERIES) {
            toolCallsTruncated = true
            log.warn('Giving up after repeated truncated tool calls', {
              recoveries: toolCallRecoveries,
              roundMs
            })
            break
          }
          toolCallRecoveries += 1
          log.warn('Recovering from a truncated tool call', {
            attempt: toolCallRecoveries,
            roundMs,
            argumentsChars,
            preview,
            runtimeOutput: this.runtime.recentOutput()
          })
          messages.push({ role: 'user', content: truncatedToolCallGuidance(preview) })
          continue
        }
        // Same rule the cloud providers follow, and for the same reason: a
        // failure on a later round — llama-server killed for memory, a dropped
        // stream — must not take the text and completed tool work of the rounds
        // that succeeded with it. Round 0 has nothing to lose and the described
        // message is the whole value of the turn, so that still throws.
        const described = await this.describeGenerationError(error)
        if (!content && !hadAnyToolAttempt) throw described
        providerError = toStopDetail(described) ?? 'The local runtime gave no reason.'
        log.error('Local vision generation failed mid-turn; keeping the work already done:', error)
        break
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
          // stands in for it. Editing the round's own text is all that is
          // needed now it is folded into `content` at the round boundary —
          // this used to rewind `content` by exactly this round's length,
          // which only held while the two were concatenated verbatim.
          const stripped = stripFallbackCall(roundContent, fallback)
          roundContent = stripped
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
    // The last round has no next iteration to fold it in.
    content = appendRoundText(content, roundContent)

    // Only a throw when the turn has nothing to lose. Throwing discards the
    // whole `GenerateOutcome`, so on a turn that had already streamed a reply
    // and written files across a dozen rounds it destroyed all of it — the user
    // saw a bare red error, while the tool work sat on disk unrecorded and
    // unattributed to any message. A late runtime fault is a reason to end the
    // turn, never a reason to throw away what it accomplished; `runtime-stalled`
    // reports it just as plainly with the content kept.
    if (staleParseFailure && !content && !hadAnyToolAttempt) {
      throw new Error(
        'The local runtime stopped running the model and returned the same tool-call parse ' +
          'failure from an earlier reply. Reload the model to clear it, then try again.'
      )
    }

    const durationMs = Math.max(1, Date.now() - startedAt)
    const stats: GenerationStats = {
      tokens: outputTokens,
      durationMs,
      tokensPerSecond: outputTokens / (durationMs / 1000),
      // Reported here, unlike the node-llama-cpp path, because this transport
      // genuinely has the figure. `LlamaService.countPromptTokens` — what
      // `runGeneration` falls back to when this is absent — measures only the
      // user's new prompt text, on the stated grounds that the local engine
      // reuses its KV cache turn over turn rather than re-billing the whole
      // context. True of that engine; not of this one, which re-sends the
      // entire conversation on every round and has just measured it with the
      // model's own tokenizer. Left absent, a vision turn's input was recorded
      // as `prompt.length / 4` — off by the whole system prompt, history and
      // tool schemas.
      inputTokens: measured?.fixedTokens
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
      stopped:
        stopped ||
        roundsExhausted ||
        tokenLimit ||
        toolCallsTruncated ||
        contextExhausted !== null ||
        staleParseFailure ||
        providerError !== null,
      // Ordered most-specific first: an outright failure, a runtime fault and
      // an exhausted context are all diagnoses the coarser reasons would hide.
      stopReason: providerError
        ? 'provider-error'
        : staleParseFailure
          ? 'runtime-stalled'
          : contextExhausted === 'fixed'
            ? 'fixed-context-limit'
            : contextExhausted === 'in-turn'
              ? 'context-limit'
              : toolCallsTruncated
                ? 'tool-call-truncated'
                : roundsExhausted
                  ? 'rounds-exhausted'
                  : stopped
                    ? 'user'
                    : tokenLimit
                      ? 'token-limit'
                      : undefined,
      stopDetail: providerError ?? undefined
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
    const conversationText = messages.map(messageCostText).filter(Boolean).join('\n')
    const [conversationTokens, promptTokens, toolSchemaTokens] = await Promise.all([
      this.runtime.countTokens(conversationText),
      this.runtime.countTokens(prompt),
      tools ? this.runtime.countTokens(JSON.stringify(tools)) : Promise.resolve(0)
    ])
    if (conversationTokens === null || promptTokens === null || toolSchemaTokens === null) {
      return null
    }
    // Everything `/tokenize` structurally cannot see: the chat template's own
    // per-message framing, and the projector's embedding cost for each image.
    // Both are real prompt tokens on the server, so leaving them out inflates
    // the output ceiling by exactly the amount most likely to overflow.
    const untokenizable =
      messages.length * MESSAGE_FRAMING_TOKENS +
      messages.reduce((total, message) => total + imagePartCount(message), 0) * IMAGE_TOKEN_ESTIMATE
    // `messages` already ends with the current prompt, so subtract it back out
    // to keep `promptTokens` an incremental figure and `fixedTokens` a total.
    const systemTokens = Math.max(0, conversationTokens + untokenizable - promptTokens)
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
    modelResultBudget: { current: ModelToolResultBudget | null },
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
      modelResultBudget,
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
      targetFixedTokens: toolSurfaceTargetTokens(this.contextSize),
      maxDirectTools: maxDirectToolsForContext(this.contextSize),
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

    // Chosen before rendering, walking the history backwards. The render pass
    // below goes forwards, so spending the budget as it went handed every slot
    // to the *oldest* pictures in the conversation and dropped the ones just
    // being discussed — the opposite of what a follow-up question needs. The
    // cloud transports get this right via `reopenRecentHistoryImages`; the name
    // is the whole point.
    const carriedImages = new Set<string>()
    let remainingImages = MAX_VISION_IMAGES - currentImages.length
    for (
      let turnIndex = boundedHistory.length - 1;
      turnIndex >= 0 && remainingImages > 0;
      turnIndex--
    ) {
      const attachments = boundedHistory[turnIndex].attachments ?? []
      for (let index = attachments.length - 1; index >= 0 && remainingImages > 0; index--) {
        if (attachments[index].kind !== 'image') continue
        carriedImages.add(`${turnIndex}:${index}`)
        remainingImages -= 1
      }
    }

    for (const [turnIndex, turn] of boundedHistory.entries()) {
      if (turn.role !== 'user' && turn.role !== 'assistant') continue
      const toolNotes = (turn.toolCalls ?? []).map(rememberToolCallForModel).join('\n\n')
      const text = toolNotes ? `${turn.content}\n\n${toolNotes}`.trim() : turn.content
      if (turn.role === 'assistant') {
        if (text) messages.push({ role: 'assistant', content: text })
        continue
      }

      const images: ChatImageInput[] = []
      for (const [index, attachment] of (turn.attachments ?? []).entries()) {
        if (!carriedImages.has(`${turnIndex}:${index}`)) continue
        const image = await reopenChatImage(attachment)
        if (image) images.push(image)
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

/**
 * Free room inside an in-progress turn by replacing the *contents* of older
 * tool results with a short note, in place.
 *
 * Replaced rather than removed, deliberately. An assistant `tool_calls` message
 * whose matching `role: 'tool'` reply is missing is a malformed exchange: chat
 * templates render it inconsistently and some refuse it outright. Rewriting the
 * content keeps every call paired with a reply while shedding the bulk, which
 * on a tool-heavy turn is almost entirely file text the model has already read.
 *
 * The note names the tool and says the result is recoverable, so a model that
 * still needs the content can ask for it again instead of inventing it —
 * silently emptying a result is exactly the kind of gap the fabrication
 * detectors in `toolCallFallback.ts` exist to catch.
 *
 * Head-truncating rather than summarizing, at every tier short of the last.
 * The head of a tool result is its most load-bearing part — the path, the match
 * count, the first lines of the file — and keeping it costs one string slice,
 * where summarizing would cost a whole extra generation on a slow local model
 * at the exact moment the user is already waiting. Real summarization does
 * happen to this material, one level up: a turn that ends `'context-limit'` is
 * a recoverable stop, so `boundedChatRunner` opens a fresh cycle whose history
 * goes through `boundHistoryForStatelessProvider`'s rolling summary.
 *
 * @returns how many results this tier shortened.
 */
function reclaimToolResultRoom(messages: ChatCompletionMessageParam[], tier: ReclaimTier): number {
  const toolNameById = new Map<string, string>()
  for (const message of messages) {
    for (const call of toolCallsOf(message)) {
      if (call.id && call.function?.name) toolNameById.set(call.id, call.function.name)
    }
  }

  const reclaimable: number[] = []
  messages.forEach((message, index) => {
    if (message.role !== 'tool') return
    if (typeof (message as { content?: unknown }).content === 'string') reclaimable.push(index)
  })

  let reclaimed = 0
  for (const index of reclaimable.slice(0, Math.max(0, reclaimable.length - tier.protectRecent))) {
    const message = messages[index] as { content: string; tool_call_id?: string }
    const name = (message.tool_call_id && toolNameById.get(message.tool_call_id)) || 'a tool'
    // Every tier slices from the head of whatever is there now, so re-running a
    // tighter tier over an already-trimmed result just shortens it further
    // instead of stacking notices.
    const shortened =
      tier.keepChars > 0
        ? `${message.content.slice(0, tier.keepChars).trimEnd()}\n${RECLAIMED_RESULT_MARKER} The rest of ${name} was trimmed to make room in this turn. Run it again if you need the whole thing — do not guess at the rest.`
        : `${RECLAIMED_RESULT_MARKER} The full result of ${name} was dropped to make room in this turn. Run it again if you still need it — do not guess at what it said.`
    // A "shortening" that grew the message buys nothing and would loop.
    if (shortened.length >= message.content.length) continue
    messages[index] = {
      ...(messages[index] as object),
      content: shortened
    } as ChatCompletionMessageParam
    reclaimed += 1
  }
  return reclaimed
}

interface ReclaimTier {
  /** Characters kept from the head of each result; `0` drops the body entirely. */
  keepChars: number
  /** Most recent results left untouched at this tier. */
  protectRecent: number
}

/**
 * Escalating passes, tried in order until the prompt fits again.
 *
 * The last tier gives up protecting all but the single most recent result:
 * losing context the model is still working from is bad, but it is strictly
 * better than ending the turn, and `PROTECTED_RECENT_TOOL_RESULTS` alone can
 * deadlock a turn whose two newest results are themselves the whole window.
 */
const RECLAIM_TIERS: readonly ReclaimTier[] = [
  { keepChars: 2_000, protectRecent: PROTECTED_RECENT_TOOL_RESULTS },
  { keepChars: 400, protectRecent: PROTECTED_RECENT_TOOL_RESULTS },
  { keepChars: 0, protectRecent: PROTECTED_RECENT_TOOL_RESULTS },
  { keepChars: 0, protectRecent: 1 }
]

/** Prefix identifying an already-shortened result. */
const RECLAIMED_RESULT_MARKER = '[Result trimmed to fit the context.]'

function toOpenAiTools(toolFunctions: Record<string, ToolFunction>): ChatCompletionTool[] {
  return Object.entries(toolFunctions).map(([name, fn]) => {
    return {
      type: 'function',
      function: {
        name,
        description: fn.description,
        parameters: toolParameterSchema(fn.params)
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

/**
 * Last-resort guard on replayed history — **not** this transport's real
 * bounding, which now happens upstream in `runGeneration` via
 * `boundHistoryForStatelessProvider`, where overflow is summarized into a
 * rolling snapshot instead of discarded.
 *
 * Kept because this method can be reached with history that never went through
 * that path, and because upstream's estimate can't see image token cost. The
 * fraction is deliberately *looser* than upstream's own budget: if this cut
 * first, it would silently drop the very turns summarization just decided to
 * keep — reintroducing the silent history loss as a truncation one layer down.
 */
const HISTORY_BACKSTOP_CONTEXT_FRACTION = 0.85

function boundHistory(history: ChatHistoryTurn[], contextSize: number): ChatHistoryTurn[] {
  const maxCharacters = Math.max(
    4000,
    Math.floor(contextSize * APPROX_CHARS_PER_TOKEN * HISTORY_BACKSTOP_CONTEXT_FRACTION)
  )
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

/** Token target `boundToolSurface` sizes this transport's native surface against. */
function toolSurfaceTargetTokens(contextSize: number): number {
  return Math.max(1_200, Math.floor(contextSize * 0.28))
}

/** Small contexts rely more heavily on the deferred gateway to preserve working room. */
function maxDirectToolsForContext(contextSize: number): number {
  return Math.max(8, Math.min(24, Math.floor(contextSize / 1_024) + 4))
}

/**
 * Tool-schema cost to hold back when compacting history for a turn on this
 * transport, before its real surface exists.
 *
 * History is bounded in `runGeneration` — upstream of `generate()`, so the
 * exact figure genuinely is not knowable yet. Reserving nothing (which this
 * path did until now, unlike the node-llama-cpp path) hands the compaction
 * planner a budget short by the whole schema surface, and because schemas are
 * fixed overhead the shortfall comes out of the reply: a 32K project chat
 * measured 30,341 tokens of fixed input and was left 1,628 tokens to answer in.
 *
 * Deliberately an upper bound rather than a live measurement. `boundToolSurface`
 * is deterministic in the two limits below, so the surface can never exceed
 * this; over-reserving costs a little replayed history, while under-reserving
 * costs the answer. A cached real measurement would be tighter but would have
 * to be keyed per conversation and would still be cold on the first turn after
 * a restart — the exact case where history is longest.
 */
export function visionToolSchemaReserveTokens(contextSize: number, hasTools: boolean): number {
  if (!hasTools) return 0
  return Math.min(
    toolSurfaceTargetTokens(contextSize),
    (maxDirectToolsForContext(contextSize) + GATEWAY_TOOL_COUNT) * ESTIMATED_TOOL_SCHEMA_TOKENS
  )
}

function estimatedInput(params: GenerateParams, toolCount: number): MeasuredInput {
  const systemTokens = Math.ceil((params.systemPrompt?.length ?? 0) / 4)
  const promptTokens = Math.ceil(params.prompt.length / 4)
  const toolSchemaTokens = toolCount * ESTIMATED_TOOL_SCHEMA_TOKENS
  return {
    systemTokens,
    promptTokens,
    toolSchemaTokens,
    fixedTokens: systemTokens + promptTokens + toolSchemaTokens
  }
}

/**
 * Everything about one rendered message that costs text tokens: its content
 * *and* the tool calls it carries.
 *
 * The tool calls are the part that matters. This transport replays the whole
 * message array every round, and an assistant tool-call message stores its
 * payload in `tool_calls[].function.arguments`, not in `content` — which is
 * `null` whenever the model called a tool without narrating. Measuring only
 * `content` therefore scored the single largest thing in the conversation as
 * zero: a `write_file` call carries an entire file body, and it is re-sent on
 * every subsequent round.
 *
 * Live failure this fixes: a turn measured at 11,849 fixed tokens was sized for
 * 3,420 more of output, while llama-server reported the real prompt reaching
 * 16,383 of a 16,384 context (`truncated = 1`). The ~4,450-token gap was
 * exactly the tool-call arguments this function used to skip. The model was cut
 * off mid-JSON, llama-server's own `--jinja` parse of the arguments threw, and
 * the whole request 500'd.
 *
 * Image parts are counted separately (see `IMAGE_TOKEN_ESTIMATE`), because
 * `/tokenize` takes text only.
 */
function messageCostText(message: ChatCompletionMessageParam): string {
  const parts: string[] = []
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') {
    parts.push(content)
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'object' && part && 'text' in part) {
        parts.push(String((part as { text: unknown }).text))
      }
    }
  }
  for (const call of toolCallsOf(message)) {
    parts.push(call.function?.name ?? '', call.function?.arguments ?? '')
  }
  return parts.join('')
}

interface RenderedToolCall {
  id?: string
  function?: { name?: string; arguments?: string }
}

function toolCallsOf(message: ChatCompletionMessageParam): RenderedToolCall[] {
  const calls = (message as { tool_calls?: unknown }).tool_calls
  return Array.isArray(calls) ? (calls as RenderedToolCall[]) : []
}

/** How many image parts one rendered message carries. */
function imagePartCount(message: ChatCompletionMessageParam): number {
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return 0
  return content.filter(
    (part) => typeof part === 'object' && part && (part as { type?: unknown }).type === 'image_url'
  ).length
}
