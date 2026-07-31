import OpenAI, { APIUserAbortError } from 'openai'
import type {
  FunctionTool,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputItem
} from 'openai/resources/responses/responses'
import type { ChatHistoryTurn, ChatImageInput, GenerationStats } from '@shared/chat.types'
import { DEFAULT_OPENAI_MODEL } from '@shared/openaiModels'
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
import { settingsStore } from '../settings/SettingsStore'
import { tokenActivityStore } from '../stats/TokenActivityStore'
import { createLogger } from '../utils/logger'
import type { LlmProvider } from './LlmProvider'
import { cloudCompatibleImages, openAiUserContent } from './cloudVisionContent'
import {
  assertCloudVisionCompatible,
  CLOUD_VISION_MIME_TYPES,
  createVisualInputQueue,
  drainVisualInputs,
  MAX_VISION_IMAGES,
  reopenRecentHistoryImages,
  selectCurrentVisionImages
} from '../vision/imageInputs'

const log = createLogger('openai')

const DEFAULT_MAX_TOKENS = 4096
/**
 * Cap on tool-use round trips within a single generation, mirroring the
 * local engine's `MAX_FALLBACK_ROUNDS` and the Anthropic provider's own cap —
 * bounds a model stuck repeatedly calling tools without ever finishing.
 */
const MAX_TOOL_ROUNDS = 20

/**
 * Trivial local stand-in for node-llama-cpp's `defineChatSessionFunction`,
 * which is itself just `({ description, params, handler }) => ({ description, params, handler })`
 * — see AnthropicProvider.ts for the full explanation. Reused here so both
 * cloud providers share the exact same tool factories as the local engine.
 */
const defineToolFunction = ((fn) => fn) as DefineChatSessionFunction

/**
 * Cloud provider backed by OpenAI's Responses API (ChatGPT/GPT-5.x and Codex
 * models). Implements the same `LlmProvider` contract as the local engine and
 * the Anthropic provider, reusing the same tool factories, history
 * sanitization, and tool-call replay conventions.
 */
class OpenAiProvider implements LlmProvider {
  id = 'openai'

  async generate(params: GenerateParams): Promise<GenerateOutcome> {
    const settings = settingsStore.get().provider.openai
    const apiKey = settings.apiKey.trim()
    if (!apiKey) {
      throw new Error(
        'No OpenAI API key configured. Add one in Settings → AI & Models → Cloud models.'
      )
    }

    const client = new OpenAI({ apiKey })
    const model = params.modelOverride?.trim() || settings.model.trim() || DEFAULT_OPENAI_MODEL
    const visualInputs = createVisualInputQueue(MAX_VISION_IMAGES, CLOUD_VISION_MIME_TYPES)

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
          imageGeneration: { provider: 'openai' },
          email: params.tools.email,
          memory: params.tools.memory,
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
          loopGuard: createLoopGuardState(),
          // Fresh every generation call, same reasoning as `turnGate` above —
          // see `ToolRuntimeContext.progress`'s doc comment.
          progress: { madeChange: false },
          // Cloud contexts are not measured against a real tokenizer in this
          // pass (their context windows are large enough that the observed
          // bug's disk-oriented byte caps aren't the reported problem) — see
          // `ToolRuntimeContext.modelResultBudget`'s doc comment. Tools fall
          // back to their own existing caps unchanged.
          modelResultBudget: { current: null },
          // Reuse the caller-owned tracker when this call is part of a
          // bounded multi-cycle/multi-turn task (see
          // `ToolRuntimeContext.readCoverage`'s doc comment); otherwise a
          // fresh one with no cross-call effect.
          readCoverage: params.tools.readCoverage ?? createReadCoverageTracker(),
          visualInputs,
          signal: params.signal,
          emit: params.tools.onActivity,
          confirm: params.tools.confirm
        })
      : undefined

    const openAiTools = toolFunctions ? toOpenAiTools(toolFunctions) : undefined

    const currentImages = selectCurrentVisionImages(params.images)
    assertCloudVisionCompatible(currentImages)
    const historyImages = await reopenRecentHistoryImages(
      params.history,
      MAX_VISION_IMAGES - currentImages.length
    )
    const input: ResponseInput = historyToInput(params.history, historyImages)
    input.push({ role: 'user', content: openAiUserContent(params.prompt, currentImages) })

    const maxOutputTokens = params.options?.maxTokens || DEFAULT_MAX_TOKENS
    const startedAt = Date.now()
    let content = ''
    let outputTokens = 0
    // Summed across rounds — each tool round re-bills the whole conversation.
    let inputTokens = 0
    let stopped = false

    const maxToolRounds = params.maxProviderRounds ?? MAX_TOOL_ROUNDS
    let roundsExhausted = false
    for (let round = 0; round < maxToolRounds; round++) {
      if (params.signal?.aborted) {
        stopped = true
        break
      }

      const stream = client.responses.stream(
        {
          model,
          max_output_tokens: maxOutputTokens,
          // temperature/top_p are deliberately omitted: reasoning models
          // (the gpt-5.x / Codex family) reject non-default sampling
          // parameters, and Anodex's generation.temperature setting is tuned
          // for the local engine's sampler — prompting is the supported way
          // to steer these models instead.
          instructions: params.systemPrompt || undefined,
          input,
          tools: openAiTools,
          // Anodex resends full history on every turn (like the local
          // engine and the Anthropic provider), so there's no need for
          // OpenAI to retain the response server-side.
          store: false
        },
        { signal: params.signal }
      )

      stream.on('response.output_text.delta', (event) => {
        content += event.delta
        params.onToken(event.delta)
      })

      let response: OpenAI.Responses.Response
      try {
        response = await stream.finalResponse()
      } catch (error) {
        if (params.signal?.aborted || error instanceof APIUserAbortError) {
          stopped = true
          break
        }
        throw error
      }

      outputTokens += response.usage?.output_tokens ?? 0
      inputTokens += response.usage?.input_tokens ?? 0

      const functionCalls = response.output.filter(
        (item): item is ResponseFunctionToolCall => item.type === 'function_call'
      )
      if (functionCalls.length === 0 || !toolFunctions) break
      // There is no remaining provider round in which the model could consume
      // these results. Do not execute side effects that cannot influence a reply.
      if (round === maxToolRounds - 1) {
        roundsExhausted = true
        break
      }

      // Replay every output item (text, reasoning, function calls) then
      // execute each requested tool and feed the results back, per the
      // Responses API's function-calling protocol.
      input.push(...(response.output as ResponseInputItem[]))

      for (const call of functionCalls) {
        input.push(await runTool(toolFunctions, call))
      }
      const inspectionImages = drainVisualInputs(visualInputs)
      assertCloudVisionCompatible(inspectionImages)
      if (inspectionImages.length > 0) {
        input.push({
          role: 'user',
          content: openAiUserContent(
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
      stopped: stopped || roundsExhausted,
      stopReason: roundsExhausted ? 'rounds-exhausted' : stopped ? 'user' : undefined
    }
  }
}

/** Execute a single tool call and translate its outcome into a `function_call_output` item. */
async function runTool(
  toolFunctions: Record<string, ToolFunction>,
  call: ResponseFunctionToolCall
): Promise<ResponseInputItem.FunctionCallOutput> {
  const tool = toolFunctions[call.name]
  if (!tool) {
    return {
      type: 'function_call_output',
      call_id: call.call_id,
      output: `Unknown tool "${call.name}".`
    }
  }
  try {
    const args: unknown = call.arguments ? JSON.parse(call.arguments) : {}
    const result: unknown = await tool.handler(args)
    return {
      type: 'function_call_output',
      call_id: call.call_id,
      output: typeof result === 'string' ? result : JSON.stringify(result)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(`Tool "${call.name}" threw:`, error)
    return { type: 'function_call_output', call_id: call.call_id, output: `Error: ${message}` }
  }
}

/**
 * Project prior turns into Responses API input items, folding remembered
 * tool calls into the assistant's text using the same compact,
 * self-describing convention the local engine and Anthropic provider replay
 * (`rememberToolCallForModel`) — so a conversation that switches providers
 * mid-history still reads consistently.
 */
function historyToInput(
  history: ChatHistoryTurn[],
  imagesByTurn: ReadonlyMap<number, ChatImageInput[]>
): ResponseInput {
  const input: ResponseInput = []
  const projected = projectHistoryForModel(history)
  for (let index = 0; index < projected.length; index++) {
    const turn = projected[index]
    // Chat history turns are only ever user/assistant in practice — the
    // system prompt is threaded separately via `GenerateParams.systemPrompt`.
    if (turn.role !== 'user' && turn.role !== 'assistant') continue
    const toolNotes = (turn.toolCalls ?? []).map(rememberToolCallForModel).join('\n\n')
    const content = toolNotes ? `${turn.content}\n\n${toolNotes}`.trim() : turn.content
    const images = turn.role === 'user' ? cloudCompatibleImages(imagesByTurn.get(index) ?? []) : []
    if (!content && images.length === 0) continue
    input.push({
      role: turn.role,
      content: turn.role === 'user' ? openAiUserContent(content, images) : content
    })
  }
  return input
}

function toOpenAiTools(toolFunctions: Record<string, ToolFunction>): FunctionTool[] {
  return Object.entries(toolFunctions).map(([name, fn]) => ({
    type: 'function',
    name,
    description: fn.description ?? null,
    parameters: toParametersSchema(fn.params),
    strict: false
  }))
}

/**
 * Convert a tool's GBNF-JSON param schema (see `ToolFunction`) to a plain
 * JSON Schema object for OpenAI's `parameters` field. The two are
 * structurally the same shape, with one deliberate adaptation at the top
 * level: node-llama-cpp's grammar-based function calling always requires
 * every declared top-level property regardless of the schema's own
 * `required` field (a documented GBNF limitation — see `AnthropicProvider.ts`
 * for the full explanation), so every Anodex tool is written assuming that
 * behavior. Forcing `required` to match here keeps GPT filling in the same
 * top-level fields the local engine would have forced it to.
 *
 * Not using `strict: true` mode deliberately — some tools (e.g. `patch_file`)
 * have nested object schemas with genuinely optional fields, and strict mode
 * would require recursively forcing every nested object to list all its own
 * properties as required too, which would misrepresent real optionality.
 */
function toParametersSchema(params: ToolFunction['params']): Record<string, unknown> {
  const schema = (params ?? {}) as { properties?: Record<string, unknown> }
  const properties = schema.properties ?? {}
  return {
    type: 'object',
    properties,
    required: Object.keys(properties)
  }
}

/**
 * Narrow, tool-free summary call used only for cloud context compaction (see
 * `boundHistoryForCloudProvider` in `contextAssembler.ts`) — isolated from
 * normal generation: no tools, no streaming, no activity/stats recording.
 * Best-effort, matching the local engine's equivalent: `null` on any failure
 * or a degenerate (too-short) result, so the caller falls back to just
 * dropping the older turns instead of keeping a useless "summary".
 *
 * With `previousSummary`, performs a replacement-style rolling update (see
 * `foldIntoRollingSummary` in `rollingSummary.ts`): the returned text
 * REPLACES the previous summary rather than being appended to it.
 */
export async function summarizeForCompactionOpenAi(
  transcript: string,
  previousSummary?: string,
  modelOverride?: string
): Promise<string | null> {
  const settings = settingsStore.get().provider.openai
  const apiKey = settings.apiKey.trim()
  if (!apiKey) return null

  const client = new OpenAI({ apiKey })
  const model = modelOverride?.trim() || settings.model.trim() || DEFAULT_OPENAI_MODEL

  try {
    const response = await client.responses.create({
      model,
      max_output_tokens: MAX_COMPACTION_SUMMARY_TOKENS,
      input: [
        {
          role: 'user',
          content: previousSummary
            ? buildCompactionUpdatePrompt(transcript, previousSummary)
            : buildCompactionSummaryPrompt(transcript)
        }
      ]
    })
    // Real billed usage with no chat turn attached to it — fold into the
    // daily/model token totals so the usage gauge and daily cap comparison
    // aren't blind to compaction spend (see `recordAncillaryUsage`'s comment).
    if (response.usage) {
      tokenActivityStore.recordAncillaryUsage({
        inputTokens: response.usage.input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
        modelId: model,
        modelName: `OpenAI — ${model}`
      })
    }
    const text = response.output_text?.trim() ?? ''
    return text.length >= MIN_SUMMARY_CHARS ? text : null
  } catch (error) {
    log.warn('Cloud history compaction summary failed:', error)
    return null
  }
}

/**
 * Confirm an OpenAI API key actually works, and that `model` is reachable
 * with it. Uses `models.retrieve` — a metadata-only call, not a generation —
 * so checking a key never spends tokens. Throws a message already suitable
 * to show the user; callers just need to catch and relay it.
 */
export async function verifyOpenAiKey(apiKey: string, model: string): Promise<void> {
  const client = new OpenAI({ apiKey })
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

export const openAiProvider: LlmProvider = new OpenAiProvider()
