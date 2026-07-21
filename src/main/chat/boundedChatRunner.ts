import type { ChatHistoryTurn, ChatRequest, GenerationStats } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import { sanitizeHistoryTurn } from '@shared/chatSanitizer'
import { runGeneration, type RunGenerationIo, type RunGenerationResult } from './runGeneration'
import { isRecoverableGenerationStop } from './recoverableStop'

/**
 * Nudge prompt for every continuation cycle after the first — deliberately
 * generic (unlike Agent's goal-and-`finish_goal`-specific `CONTINUE_PROMPT`
 * in `agentPrompts.ts`): a chat turn has no standing goal object or
 * termination tool, just the original user message and whatever real
 * progress (tool results, partial prose) already streamed into this same
 * reply before the model hit a bounded stop.
 */
const CHAT_CONTINUE_PROMPT =
  'Continue exactly where you left off. Do not repeat work already done above — reuse the tool ' +
  'results and text already produced in this reply. If the task is already fully complete, say so ' +
  'and stop.'

/**
 * Cross-cycle wall-clock ceiling, matching the live-test budget in
 * `docs/CONTEXT_ADAPTIVE_RUNTIME_RECOVERY_HANDOFF.md` (Test A: "final report
 * within 15 minutes, or durable Pause"). Deliberately NOT a per-cycle budget
 * — `DEFAULT_INTERACTIVE_BUDGET.maxDurationMs` in `GenerationBudget.ts`
 * already bounds a single cycle to 15 minutes on its own; this instead caps
 * how long the *whole* bounded reply (however many cycles) is allowed to run
 * before no further cycle may start. A cycle already in flight when the
 * deadline passes still finishes (or hits its own ceiling) normally — this
 * only gates *starting another one*.
 */
const TOTAL_WALL_CLOCK_MS = 15 * 60_000

/**
 * At most this many `runGeneration()` calls total for one bounded reply — a
 * hard ceiling independent of the wall clock, so a pathological run of fast,
 * barely-progressing cycles can't loop indefinitely just because each one
 * individually finishes quickly.
 */
const MAX_CYCLES = 5

/**
 * Wraps `runGeneration()` in an outer continuation loop, so a single request
 * (Project Chat's `Chat.send`, or any other `runGeneration` caller) can make
 * bounded progress across multiple provider turns instead of stopping dead
 * the moment one turn hits a soft ceiling (tool/token/time/context-shift
 * limit) — see "Phase 5: Shared bounded task continuation" in
 * `docs/CONTEXT_ADAPTIVE_RUNTIME_RECOVERY_HANDOFF.md`. A live 8K project-chat
 * audit made real progress (33 completed tool calls, partial report text)
 * before hitting exactly this kind of bounded stop with nothing to
 * automatically pick it back up; this is that missing seam.
 *
 * Reuses Agent's exact recoverable-stop classification
 * (`isRecoverableGenerationStop`) rather than inventing a second, possibly
 * inconsistent notion of "this is worth continuing" for chat — see that
 * function's doc comment. Every cycle streams into the SAME `messageId` via
 * `io`'s callbacks, so from the renderer's perspective this looks exactly
 * like one longer-running reply: no new UI, IPC shape, or persisted-message
 * concept is needed. Only continues automatically when the previous cycle
 * both stopped for a recoverable reason AND made real progress (a
 * successful tool call, or new visible text) — a cycle that produced
 * neither is treated as "no durable progress," which per that same section
 * should pause rather than loop, so this stops there instead of retrying
 * blindly.
 *
 * Critical Thinking is deliberately NOT routed through this — it keeps its
 * own evidence-first `CriticalThinkingResearchRunner`, per that same
 * document's explicit instruction not to force it into a shared native
 * function-call continuation loop.
 */
export async function runBoundedChatGeneration(
  request: ChatRequest,
  io: RunGenerationIo
): Promise<RunGenerationResult> {
  const deadline = Date.now() + TOTAL_WALL_CLOCK_MS
  let history: ChatHistoryTurn[] = request.history
  let prompt = request.prompt
  let context = request.context ?? undefined
  let combinedContent = ''
  let combinedThinking = ''
  let totalTokens = 0
  let totalDurationMs = 0
  let fabricationDetectedAnyCycle = false
  let last: RunGenerationResult | undefined
  const memoryUsed: NonNullable<RunGenerationResult['memoryUsed']> = []
  const transcriptRecallUsed: NonNullable<RunGenerationResult['transcriptRecallUsed']> = []

  for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
    let madeProgressThisCycle = false
    // Keyed by call id, same shape/reasoning as `AgentRunService.runTurn`'s
    // `toolCallsById`: a call's *latest* status (running → terminal)
    // overwrites the earlier one, and `Map` insertion order still reflects
    // call order. Reset every cycle — each cycle gets its own history turn
    // below, carrying only the tool calls it actually made.
    const toolCallsById = new Map<string, ToolCall>()
    const result = await runGeneration(
      { ...request, history, prompt, context },
      {
        ...io,
        onActivity: (call) => {
          if (call.status === 'success') madeProgressThisCycle = true
          toolCallsById.set(call.id, call)
          io.onActivity?.(call)
        }
      }
    )
    last = result
    combinedContent = combinedContent ? `${combinedContent}\n\n${result.content}` : result.content
    if (result.thinking) {
      combinedThinking = combinedThinking
        ? `${combinedThinking}\n\n${result.thinking}`
        : result.thinking
    }
    totalTokens += result.stats.tokens
    totalDurationMs += result.stats.durationMs
    if (result.fabricationDetected) fabricationDetectedAnyCycle = true
    if (result.memoryUsed) memoryUsed.push(...result.memoryUsed)
    if (result.transcriptRecallUsed) transcriptRecallUsed.push(...result.transcriptRecallUsed)
    if (result.context) context = result.context

    if (result.content.trim().length > 0) madeProgressThisCycle = true

    const canContinue =
      result.stopped &&
      isRecoverableGenerationStop(result.stopReason) &&
      madeProgressThisCycle &&
      cycle < MAX_CYCLES - 1 &&
      Date.now() < deadline &&
      !io.signal?.aborted

    if (!canContinue) break

    // Without `toolCalls` here, a session rebuild between cycles (proactive
    // or reactive mid-turn compaction, or simply a different conversationId
    // fast path missing) would replay this cycle's assistant turn as bare
    // prose — the model would have no record of which files it already read
    // or what it found, and could report starting "fresh" on the very next
    // cycle despite dozens of completed tool calls. `ToolCall.result` is
    // exactly the field the chat/session-rebuild path already relies on to
    // let a resumed conversation "remember" past tool output — see its doc
    // comment in `tools.types.ts`.
    const cycleToolCalls = toolCallsById.size > 0 ? [...toolCallsById.values()] : undefined
    history = [
      ...history,
      { role: 'user', content: prompt },
      sanitizeHistoryTurn({
        role: 'assistant',
        content: result.content,
        toolCalls: cycleToolCalls
      })
    ]
    prompt = CHAT_CONTINUE_PROMPT
  }

  // The loop always runs at least once, so `last` is always assigned —
  // TypeScript can't see that through the `for` loop, hence the assertion.
  const finalResult = last as RunGenerationResult
  const stats: GenerationStats = {
    tokens: totalTokens,
    durationMs: totalDurationMs,
    tokensPerSecond: totalDurationMs > 0 ? (totalTokens / totalDurationMs) * 1000 : 0
  }

  return {
    ...finalResult,
    content: combinedContent,
    stats,
    thinking: combinedThinking || undefined,
    fabricationDetected: fabricationDetectedAnyCycle,
    memoryUsed: memoryUsed.length > 0 ? memoryUsed : undefined,
    transcriptRecallUsed: transcriptRecallUsed.length > 0 ? transcriptRecallUsed : undefined,
    context
  }
}
