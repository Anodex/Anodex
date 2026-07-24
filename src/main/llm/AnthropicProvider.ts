import Anthropic, { APIUserAbortError } from '@anthropic-ai/sdk'
import type { ChatHistoryTurn, ChatImageInput, GenerationStats } from '@shared/chat.types'
import { DEFAULT_ANTHROPIC_MODEL } from '@shared/anthropicModels'
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
import { providerUsageStore } from './ProviderUsageStore'
import type { LlmProvider } from './LlmProvider'
import { anthropicUserContent, cloudCompatibleImages } from './cloudVisionContent'
import {
  assertCloudVisionCompatible,
  CLOUD_VISION_MIME_TYPES,
  createVisualInputQueue,
  drainVisualInputs,
  MAX_VISION_IMAGES,
  reopenRecentHistoryImages,
  selectCurrentVisionImages
} from '../vision/imageInputs'

const log = createLogger('anthropic')

const DEFAULT_MAX_TOKENS = 4096
/**
 * Cap on tool-use round trips within a single generation, mirroring the local
 * engine's `MAX_FALLBACK_ROUNDS` — bounds a model stuck repeatedly calling
 * tools without ever finishing so a turn can't loop forever.
 */
const MAX_TOOL_ROUNDS = 20

/**
 * Trivial local stand-in for node-llama-cpp's `defineChatSessionFunction`,
 * which is itself just `({ description, params, handler }) => ({ description, params, handler })`
 * — see node_modules/node-llama-cpp/dist/evaluator/LlamaChatSession/utils/defineChatSessionFunction.js.
 * Defining it locally means `buildTools()` (the same tool factories the local
 * engine uses) can be reused here without pulling in node-llama-cpp at all.
 */
const defineToolFunction = ((fn) => fn) as DefineChatSessionFunction

/**
 * Cloud provider backed by the Anthropic Messages API. Implements the same
 * `LlmProvider` contract as the local engine, reusing its tool factories,
 * history sanitization, and tool-call replay conventions so a conversation
 * reads the same regardless of which provider produced it.
 */
class AnthropicProvider implements LlmProvider {
  id = 'anthropic'

  async generate(params: GenerateParams): Promise<GenerateOutcome> {
    const settings = settingsStore.get().provider.anthropic
    const apiKey = settings.apiKey.trim()
    if (!apiKey) {
      throw new Error(
        'No Anthropic API key configured. Add one in Settings → AI & Models → Cloud models.'
      )
    }

    const client = new Anthropic({ apiKey })
    const model = params.modelOverride?.trim() || settings.model.trim() || DEFAULT_ANTHROPIC_MODEL
    const visualInputs = createVisualInputQueue(MAX_VISION_IMAGES, CLOUD_VISION_MIME_TYPES)

    const toolFunctions = params.tools
      ? buildTools(defineToolFunction, {
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
          disabledTools: params.tools.disabledTools,
          mcpTools: params.tools.mcpTools,
          evidenceFocus: params.tools.evidenceFocus,
          recordArtifact: params.tools.recordArtifact,
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

    const anthropicTools = toolFunctions ? toAnthropicTools(toolFunctions) : undefined

    const currentImages = selectCurrentVisionImages(params.images)
    assertCloudVisionCompatible(currentImages)
    const historyImages = await reopenRecentHistoryImages(
      params.history,
      MAX_VISION_IMAGES - currentImages.length
    )
    const messages: Anthropic.MessageParam[] = historyToMessages(params.history, historyImages)
    messages.push({ role: 'user', content: anthropicUserContent(params.prompt, currentImages) })

    const maxTokens = params.options?.maxTokens || DEFAULT_MAX_TOKENS
    const startedAt = Date.now()
    let content = ''
    let outputTokens = 0
    let stopped = false

    const maxToolRounds = params.maxProviderRounds ?? MAX_TOOL_ROUNDS
    let roundsExhausted = false
    for (let round = 0; round < maxToolRounds; round++) {
      if (params.signal?.aborted) {
        stopped = true
        break
      }

      const stream = client.messages.stream(
        {
          model,
          max_tokens: maxTokens,
          // temperature/top_p are deliberately omitted: Opus 4.7+/Sonnet 5
          // reject non-default sampling parameters outright, and Anodex's
          // generation.temperature setting is tuned for the local engine's
          // sampler, not Claude's — prompting is the supported way to steer
          // Claude's behavior instead.
          system: params.systemPrompt || undefined,
          messages,
          tools: anthropicTools
        },
        { signal: params.signal }
      )

      stream.on('text', (delta) => {
        content += delta
        params.onToken(delta)
      })
      // Best-effort: `.response` is only populated once the connection is
      // established, and reading it must never affect generation itself —
      // a change in SDK internals here should silently stop updating the
      // usage gauge, not break chat.
      stream.once('connect', () => captureRateLimitHeaders(stream.response))

      let response: Anthropic.Message
      try {
        response = await stream.finalMessage()
      } catch (error) {
        if (params.signal?.aborted || error instanceof APIUserAbortError) {
          stopped = true
          break
        }
        throw error
      }

      outputTokens += response.usage.output_tokens

      if (response.stop_reason !== 'tool_use' || !toolFunctions) break
      // There is no remaining provider round in which the model could consume
      // these results. Do not execute side effects that cannot influence a reply.
      if (round === maxToolRounds - 1) {
        roundsExhausted = true
        break
      }

      // Replay the assistant turn (text + tool_use blocks) then execute every
      // requested tool and feed the results back in a single user turn, per
      // Anthropic's tool-use protocol.
      messages.push({ role: 'assistant', content: response.content })

      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue
        toolResults.push(await runTool(toolFunctions, block))
      }
      if (toolResults.length === 0) break
      const inspectionImages = drainVisualInputs(visualInputs)
      assertCloudVisionCompatible(inspectionImages)
      const inspectionContent =
        inspectionImages.length > 0
          ? anthropicUserContent(
              'Inspect this visual output carefully. Use what you see to continue the task, and revise the work when needed.',
              inspectionImages
            )
          : []
      messages.push({
        role: 'user',
        content: [
          ...toolResults,
          ...(typeof inspectionContent === 'string'
            ? [{ type: 'text' as const, text: inspectionContent }]
            : inspectionContent)
        ]
      })
    }

    const durationMs = Math.max(1, Date.now() - startedAt)
    const stats: GenerationStats = {
      tokens: outputTokens,
      durationMs,
      tokensPerSecond: outputTokens / (durationMs / 1000)
    }

    return {
      content,
      stats,
      stopped: stopped || roundsExhausted,
      stopReason: roundsExhausted ? 'rounds-exhausted' : stopped ? 'user' : undefined
    }
  }
}

/**
 * Read the rate-limit window off a live Anthropic response's headers and
 * record it for the usage gauge. `anthropic-ratelimit-tokens-*` (as opposed
 * to the separate `-input-tokens-*`/`-output-tokens-*` variants) is
 * documented to already reflect whichever limit is most restrictive right
 * now, so it alone is the right single number to show. Never throws — a
 * missing/malformed header just means no gauge update this round, not a
 * failed generation.
 */
function captureRateLimitHeaders(response: Response | null | undefined): void {
  try {
    if (!response) return
    const limit = Number(response.headers.get('anthropic-ratelimit-tokens-limit'))
    const remaining = Number(response.headers.get('anthropic-ratelimit-tokens-remaining'))
    const resetAt = Date.parse(response.headers.get('anthropic-ratelimit-tokens-reset') ?? '')
    if (!Number.isFinite(limit) || !Number.isFinite(remaining) || !Number.isFinite(resetAt)) return
    providerUsageStore.recordRateLimit('anthropic', {
      tokensLimit: limit,
      tokensRemaining: remaining,
      resetAt
    })
  } catch (error) {
    log.warn('Failed to read Anthropic rate-limit headers:', error)
  }
}

/** Execute a single tool call and translate its outcome into a `tool_result` block. */
async function runTool(
  toolFunctions: Record<string, ToolFunction>,
  block: Anthropic.ToolUseBlock
): Promise<Anthropic.ToolResultBlockParam> {
  const tool = toolFunctions[block.name]
  if (!tool) {
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: `Unknown tool "${block.name}".`,
      is_error: true
    }
  }
  try {
    const result: unknown = await tool.handler(block.input)
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: typeof result === 'string' ? result : JSON.stringify(result)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(`Tool "${block.name}" threw:`, error)
    return { type: 'tool_result', tool_use_id: block.id, content: message, is_error: true }
  }
}

/**
 * Project prior turns into Anthropic message history, folding remembered
 * tool calls into the assistant's text using the same compact, self-describing
 * convention the local engine replays (`rememberToolCallForModel`) — so a
 * conversation that switches providers mid-history still reads consistently.
 */
function historyToMessages(
  history: ChatHistoryTurn[],
  imagesByTurn: ReadonlyMap<number, ChatImageInput[]>
): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = []
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
    messages.push({
      role: turn.role,
      content: turn.role === 'user' ? anthropicUserContent(content, images) : content
    })
  }
  return messages
}

function toAnthropicTools(toolFunctions: Record<string, ToolFunction>): Anthropic.Tool[] {
  return Object.entries(toolFunctions).map(([name, fn]) => ({
    name,
    description: fn.description,
    input_schema: toInputSchema(fn.params)
  }))
}

/**
 * Convert a tool's GBNF-JSON param schema (see `ToolFunction`) to Anthropic's
 * input schema. The two are structurally the same JSON Schema shape, with one
 * deliberate adaptation: node-llama-cpp's grammar-based function calling
 * always requires every declared property regardless of the schema's own
 * `required` field (a documented GBNF limitation), so every Anodex tool is
 * written assuming that behavior. Forcing `required` to match here keeps
 * Claude filling in the same fields the local engine would have forced it to.
 */
function toInputSchema(params: ToolFunction['params']): Anthropic.Tool.InputSchema {
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
export async function summarizeForCompactionAnthropic(
  transcript: string,
  previousSummary?: string,
  modelOverride?: string
): Promise<string | null> {
  const settings = settingsStore.get().provider.anthropic
  const apiKey = settings.apiKey.trim()
  if (!apiKey) return null

  const client = new Anthropic({ apiKey })
  const model = modelOverride?.trim() || settings.model.trim() || DEFAULT_ANTHROPIC_MODEL

  try {
    const response = await client.messages.create({
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
    })
    // Real billed usage with no chat turn attached to it — fold into the
    // daily/model token totals so the usage gauge and daily cap comparison
    // aren't blind to compaction spend (see `recordAncillaryUsage`'s comment).
    tokenActivityStore.recordAncillaryUsage({
      inputTokens: response.usage.input_tokens ?? 0,
      outputTokens: response.usage.output_tokens ?? 0,
      modelId: model,
      modelName: `Claude — ${model}`
    })
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()
    return text.length >= MIN_SUMMARY_CHARS ? text : null
  } catch (error) {
    log.warn('Cloud history compaction summary failed:', error)
    return null
  }
}

/**
 * Confirm an Anthropic API key actually works, and that `model` is reachable
 * with it. Uses `models.retrieve` — a metadata-only call, not a generation —
 * so checking a key never spends tokens. Throws a message already suitable
 * to show the user; callers just need to catch and relay it.
 */
export async function verifyAnthropicKey(apiKey: string, model: string): Promise<void> {
  const client = new Anthropic({ apiKey })
  try {
    await client.models.retrieve(model)
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      throw new Error('Invalid API key.')
    }
    if (error instanceof Anthropic.NotFoundError) {
      throw new Error(`Key looks valid, but model "${model}" isn't available on this account.`)
    }
    throw new Error(error instanceof Error ? error.message : 'Could not verify the API key.')
  }
}

export const anthropicProvider: LlmProvider = new AnthropicProvider()
