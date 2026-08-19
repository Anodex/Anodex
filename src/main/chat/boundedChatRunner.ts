import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type {
  ChatHistoryTurn,
  ChatRequest,
  ContextEpochHandoff,
  GenerationStats
} from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import { sanitizeHistoryTurn } from '@shared/chatSanitizer'
import { runGeneration, type RunGenerationIo, type RunGenerationResult } from './runGeneration'
import { isRecoverableGenerationStop } from './recoverableStop'
import { createTaskLedger } from '../tools/taskLedger'
import { WebSourceRegistry } from '../tools/WebSourceRegistry'
import { findUnverifiedPathClaims } from '../tools/pathClaimVerification'
import { describeTurnOutcome, isDurableChange } from './turnSummary'
import { isObservationalRunCommand, observationalCommandIdentity } from '../tools/commandEffect'
import { progressFromSettledCalls } from '../tools/turnProgress'
import { projectStore } from '../projects/ProjectStore'
import { llamaService } from '../llama/LlamaService'
import { modelReliabilityStore } from '../models/ModelReliabilityStore'
import { withEpochHandoff } from '@shared/context.types'
import { createLogger } from '../utils/logger'

/**
 * Cycle boundaries were invisible in the log. Only the provider transports
 * logged anything per round, so a turn that silently ran as three cycles read
 * as one long reply, and reconstructing why it split meant inferring it from a
 * round counter resetting to zero and cross-checking a persisted handoff that
 * had not been updated. `stopReason` is the field that answers it directly.
 */
const log = createLogger('chat:cycle')

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
 * One non-visible final pass for a response that ended with unfinished visible
 * plan rows. The only registered tool is `update_plan_step`, so this cannot
 * turn a plan correction into more workspace work or a new plan reset.
 */
const PLAN_RECONCILIATION_PROMPT =
  'Before the response ends, reconcile the current visible work plan with the work already completed. ' +
  'Use update_plan_step to mark only steps the completed work proves are finished. Do not change files, ' +
  'run commands, create a new plan, or claim unfinished work is complete. If no status can be updated ' +
  'honestly, reply exactly PLAN_UNCHANGED.'

/**
 * One tool-less final pass for a turn that was cut short before it could say
 * what it had done. It is told what it may not do, because the failure to avoid
 * is a confident-sounding wrap-up claiming work that never happened — the same
 * risk `findUnverifiedPathClaims` exists to catch.
 */
const CLOSING_SUMMARY_PROMPT =
  'This reply is being cut short by a limit, so close it out for the user. In a short paragraph ' +
  'or a few bullets: what you actually did, what you found, and what is still unfinished. ' +
  'Describe only work that already appears above — do not claim any change, file, or result that ' +
  'is not there, and do not start new work or ask to continue.'

/**
 * At most this many `runGeneration()` calls total for one bounded reply — a
 * hard ceiling independent of the wall clock, so a pathological run of fast,
 * barely-progressing cycles can't loop indefinitely just because each one
 * individually finishes quickly.
 */
// A normal long task can compact several times while it is still making new
// tool progress. The cross-cycle no-progress guard is the primary stop; this
// is only a distant final failsafe against a pathological endless run.
const MAX_CYCLES = 24

/**
 * How many times one identical call (same tool, same target, same result) may
 * still count as progress. Two: the original, plus the one re-read a context
 * epoch legitimately authorizes after dropping the evidence. A third identical
 * result is the model going in circles.
 */
export const REPEATED_CALL_ALLOWANCE = 2

/**
 * Cycle ceiling for a goal run (`ChatRequest.goal`), which continues on
 * *unfinished work* rather than only on a recoverable stop and so needs its own
 * bound. Higher than `MAX_CYCLES` because finishing a real goal legitimately
 * takes more turns than recovering from a budget stop, but still finite: a goal
 * that cannot be reached in this many cycles is reported unfinished rather than
 * run forever.
 */
const GOAL_MAX_CYCLES = 40

/**
 * Consecutive post-epoch cycles that may consist only of reading before the run
 * stops. One is expected and useful — the epoch deliberately dropped evidence
 * and told the model to reopen it. Two in a row means the reopening has become
 * the work, which would otherwise ride the whole goal-cycle budget without
 * producing anything.
 */
const MAX_CONSECUTIVE_RECOVERY_ONLY_CYCLES = 2

/**
 * Extra cycles granted to a turn that ended cleanly with plan steps still open.
 *
 * The model announcing its next action and then emitting a round with no tool
 * call is what ends a provider loop, and it ended four runs of one request
 * mid-investigation. An open plan is the state that says the work is not done —
 * bounded here so a plan the model never closes cannot make every later turn in
 * the conversation run three times as long.
 */
const MAX_OPEN_PLAN_CONTINUATIONS = 3

/**
 * Evidence handles listed in a context-epoch handoff.
 *
 * This replaced a "you may reopen up to N files already read earlier" allowance.
 * That allowance existed only because an epoch left no trace of the results
 * while the coverage tracker still recorded them as read, so the resumed model
 * had to be granted permission to fetch them again. The record of what was
 * gathered now survives the epoch in the ledger, so the right thing to hand the
 * model is that catalogue — and no permission, because a re-read is no longer
 * refused by any guard.
 */
const EPOCH_EVIDENCE_INDEX_ENTRIES = 12

/**
 * Wall-clock ceiling across every cycle of one goal run.
 *
 * `GenerationBudget` bounds a single cycle; without a total, forty cycles of
 * fifteen minutes each is ten hours. This is the number that makes an
 * unattended goal run safe to start, so it is deliberately conservative — the
 * user can always say "continue".
 */
const GOAL_MAX_TOTAL_MS = 30 * 60_000

/**
 * Continuation nudge for a goal run. Unlike `CHAT_CONTINUE_PROMPT`, this turn
 * *does* have a standing goal and a termination tool, so it names both — the
 * same shape as Agent's `CONTINUE_PROMPT` in `agentPrompts.ts`.
 */
function goalContinuePrompt(goal: string): string {
  return (
    `Continue working toward this goal: ${goal}\n\n` +
    'Do not repeat work already done above — reuse the tool results and text already produced in ' +
    'this reply. Take the next concrete action. When the goal is genuinely met, call finish_goal ' +
    'with a summary of the outcome — backed by evidence gathered after your last change, not ' +
    "before it: a passing test or build for code, a command's real output for behavior, a visual " +
    'inspection for anything that renders. If you are blocked and cannot make further progress, ' +
    'call finish_goal and say plainly what is blocking you.'
  )
}

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
  // One tracker for the whole bounded reply, shared by every cycle's read
  // tools — see `ReadCoverageTracker`'s doc comment. This is what actually
  // stops a later cycle from re-reading territory an earlier cycle already
  // covered, independent of whether the model itself still remembers doing
  // so (a compaction summary between cycles may not preserve that fact).
  // One ledger for the whole bounded reply — see `TaskLedger`. This is what
  // makes a context epoch survivable: the epoch drops the cycle's tool
  // transcript out of the model's context, while the ledger keeps what was read
  // and what was gathered, so the fresh cycle resumes instead of starting over.
  const ledger = io.ledger ?? createTaskLedger()
  // Same resolution `runGeneration` itself uses internally — needed here too
  // so the final reply can be checked against real disk/coverage state (see
  // `findUnverifiedPathClaims`), not just handed straight to the caller.
  const projects = projectStore.getState()
  const requestProjectId =
    'projectId' in request ? (request.projectId ?? null) : projects.activeProjectId
  const workspaceRoot =
    projects.projects.find((project) => project.id === requestProjectId)?.folderPath ?? null
  // A fresh context epoch returns to the persisted history that began this
  // reply. The compact handoff below carries completed work; replaying the
  // same reply's full, tool-heavy transcript as well would immediately refill
  // the window the epoch was created to clear.
  const baseHistory: ChatHistoryTurn[] = request.history
  let history: ChatHistoryTurn[] = baseHistory
  let prompt = request.prompt
  let context = request.context ?? undefined
  // Plan state is separate from compacted transcript history. An unfinished
  // plan remains useful for an explicit continuation, but must not silently
  // become the objective of a new concrete request in the same conversation.
  // The plan stays persisted in the UI; this only decides whether the model
  // receives it as active state for this reply.
  // An unfinished plan is real, user-visible conversation state, so it is always
  // passed. Whether it is *the current instruction* is stated in the rendered
  // plan block itself (`renderCurrentPlan`) rather than decided here by matching
  // the user's wording against continuation phrases — which made prompt phrasing
  // an implicit control channel and hid the plan from the model on most turns.
  let currentPlan = activePlan(request.plan)
  let combinedContent = ''
  let combinedThinking = ''
  let totalTokens = 0
  let totalDurationMs = 0
  let fabricationDetectedAnyCycle = false
  let last: RunGenerationResult | undefined
  const memoryUsed: NonNullable<RunGenerationResult['memoryUsed']> = []
  const transcriptRecallUsed: NonNullable<RunGenerationResult['transcriptRecallUsed']> = []
  // One registry for the whole reply, not one per cycle: the citation ids the
  // model writes have to mean the same page from the first cycle to the last.
  const webSources = new WebSourceRegistry()
  // A compaction cycle is a new provider turn, but it is still the same user
  // request. Keep a small whole-reply ledger so a model cannot make an old
  // read/command look like fresh progress simply because the context epoch
  // changed.
  const seenToolActivity = new Set<string>()
  /** How many times each epoch-independent call identity has come back. */
  const repeatedCallCounts = new Map<string, number>()
  const seenReadActivity = new Set<string>()
  const seenCycleContent = new Set<string>()
  const completedToolCalls = new Map<string, ToolCall>()
  let latestCycleToolCalls: ToolCall[] | undefined

  // A standing `/goal` turns this into a goal run: it keeps taking cycles
  // while real progress continues, and ends when the model calls `finish_goal`
  // (which the evidence gate in `agentTools.ts` can refuse) rather than after
  // one pass. See `ChatRequest.goal`.
  const goal = request.goal?.trim() || null
  const originalObjective = buildRecoveryObjective(request, goal)
  const goalDeadline = goal ? Date.now() + GOAL_MAX_TOTAL_MS : null
  const cycleCeiling = goal ? GOAL_MAX_CYCLES : MAX_CYCLES
  let goalFinished = false
  let goalBlockedReason: string | null = null
  let goalSummary: string | undefined
  let contextEpoch: ContextEpochHandoff | undefined
  let contextEpochCount = 0
  let recoveryOnlyCycles = 0
  let recoveryChurnDetected = false
  /** Extra cycles spent resuming a turn that stopped with plan steps still open. */
  let planContinuations = 0
  /**
   * Why a *chat* turn stopped continuing, when it wanted to and could not.
   *
   * Agent runs have had `goalBlockedReason` all along, but the equivalent for a
   * chat turn was never recorded: the loop simply broke and the reply ended
   * mid-sentence with nothing anywhere saying why. In a live run that made 143
   * tool calls this was the whole of the user's experience — "it stopped
   * randomly". A turn that merely finished answering leaves this `null`.
   */
  let chatEndReason: string | null = null

  for (let cycle = 0; cycle < cycleCeiling; cycle++) {
    let novelToolActivityThisCycle = false
    // Keyed by call id, same shape/reasoning as `AgentRunService.runTurn`'s
    // `toolCallsById`: a call's *latest* status (running → terminal)
    // overwrites the earlier one, and `Map` insertion order still reflects
    // call order. Reset every cycle — each cycle gets its own history turn
    // below, carrying only the tool calls it actually made.
    const toolCallsById = new Map<string, ToolCall>()
    const result = await runGeneration(
      { ...request, history, prompt, context, plan: currentPlan, contextEpoch },
      {
        ...io,
        ledger,
        webSources,
        onActivity: (call) => {
          if (call.status !== 'running') {
            completedToolCalls.set(`${cycle}:${call.id}`, call)
          }
          if (call.status === 'success' && call.madeProgress !== false) {
            const activityKey = toolActivityKey(call, contextEpochCount)
            const repeats = (repeatedCallCounts.get(repeatedCallIdentity(call)) ?? 0) + 1
            repeatedCallCounts.set(repeatedCallIdentity(call), repeats)
            // Past the allowance the call is repetition however new the epoch
            // makes it look, so it stops counting toward this cycle's progress.
            // A cycle doing anything genuinely new still passes on that call.
            if (!seenToolActivity.has(activityKey) && repeats <= REPEATED_CALL_ALLOWANCE) {
              seenToolActivity.add(activityKey)
              novelToolActivityThisCycle = true
            }
          }
          if (call.plan) currentPlan = activePlan(call.plan)
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

    settleInterruptedReadCalls(toolCallsById, completedToolCalls, cycle, io)
    const cycleToolCalls = toolCallsById.size > 0 ? [...toolCallsById.values()] : undefined
    latestCycleToolCalls = cycleToolCalls
    const normalizedContent = normalizeCycleContent(result.content)
    const novelVisibleContent =
      normalizedContent.length > 0 && !seenCycleContent.has(normalizedContent)
    if (normalizedContent.length > 0) seenCycleContent.add(normalizedContent)
    // "Did nothing but look." Decided by `kind`, not a name list: `read` covers
    // every read tool — ranges, directory listings, code search, outlines — so a
    // cycle cannot slip past the guard by mixing one `search_files` in among its
    // re-reads, which a two-name list allowed.
    // Visible narration is not durable progress when every action in a
    // post-epoch cycle is still a read. In the driving failure the model
    // changed "Let me check the current state..." slightly on every pass,
    // which made `novelVisibleContent` true and let thirteen context epochs
    // repeat the same two ranges. The tool effects decide whether recovery
    // advanced; prose cannot turn read churn into work.
    const successfulReadIdentities =
      cycleToolCalls
        ?.filter((call) => call.status === 'success' && isReadLikeCall(call))
        .map(recoveryReadIdentity) ?? []
    const hasNovelReadEvidence = successfulReadIdentities.some(
      (identity) => !seenReadActivity.has(identity)
    )
    for (const identity of successfulReadIdentities) seenReadActivity.add(identity)
    const recoveryOnlyCycle = Boolean(
      contextEpoch && cycleToolCalls?.length && cycleToolCalls.every(isReadLikeCall)
    )
    const repetitiveRecoveryCycle = recoveryOnlyCycle && !hasNovelReadEvidence
    recoveryOnlyCycles = repetitiveRecoveryCycle ? recoveryOnlyCycles + 1 : 0
    const recoveryChurn = recoveryOnlyCycles >= MAX_CONSECUTIVE_RECOVERY_ONLY_CYCLES
    const madeProgressThisCycle =
      (novelToolActivityThisCycle || novelVisibleContent) && !recoveryChurn

    // Only a *successful* finish_goal ends the run. A refusal from the
    // evidence gate (`agentTools.ts`) arrives as an error, which must read as
    // "go and verify it, then try again" — treating it as terminal would turn
    // a recoverable correction into a dead run.
    if (cycleToolCalls?.some((call) => call.name === 'finish_goal' && call.status === 'success')) {
      goalFinished = true
      goalSummary = cycleToolCalls.find((call) => call.name === 'finish_goal')?.detail
      break
    }

    // A loop guard that follows real work is a clean epoch boundary, not a
    // reason to discard the task. Starting another provider round in the same
    // generation was the bug; a compact outer continuation may resume from
    // the next action. Error/no-op-only loops remain terminal.
    const loopGuardRecovery = result.stopReason === 'loop-guard' && novelToolActivityThisCycle
    const recoveredStop =
      result.stopped &&
      isRecoverableGenerationStop(result.stopReason) &&
      (result.stopReason !== 'loop-guard' || loopGuardRecovery)
    recoveryChurnDetected ||= recoveryChurn && (recoveredStop || goalStillOpenFor(result, goal))
    const contextRecovery = result.stopReason === 'context-limit' || loopGuardRecovery
    let contextRecoveryBlocked = false
    let startedContextEpoch = false
    if (contextRecovery && !recoveryChurnDetected) {
      const unsafeNonTerminal =
        cycleToolCalls?.some((call) => call.status === 'running' && !isReadLikeCall(call)) ?? false
      if (!unsafeNonTerminal) {
        contextEpochCount++
        contextEpoch = buildContextEpochHandoff({
          epoch: contextEpochCount,
          cause: loopGuardRecovery ? 'loop-guard' : (result.contextEpochCause ?? 'in-turn'),
          objective: originalObjective,
          plan: currentPlan,
          calls: [...completedToolCalls.values()],
          workingSummary: buildRecoveryWorkingSummary(combinedContent),
          // The epoch is about to drop this cycle's tool transcript out of the
          // model's context. The record of what was gathered survives in the
          // ledger, but the resumed model has no way to know that unless it is
          // told — without this it starts the fresh cycle blind and re-reads the
          // same ground. This is what replaced the old "you may reopen 3 files"
          // allowance: knowing which ground is covered beats a quota, and a
          // re-read of what it actually needs is no longer refused.
          evidenceIndex: ledger.evidence.index(EPOCH_EVIDENCE_INDEX_ENTRIES),
          priorFixedTokens: result.contextBudget?.fixedTokens
        })
        context = withEpochHandoff(context, contextEpoch)
        startedContextEpoch = true
      } else {
        contextRecoveryBlocked = true
        goalBlockedReason =
          'Anodex stopped while a tool that could change external state was still running, so it did not create an unsafe recovery checkpoint.'
      }
    }
    // A goal run also continues through a *clean* finish that did not call
    // finish_goal — that is the autonomy. It still requires real progress, so
    // a cycle that achieved nothing stops here rather than looping.
    const goalStillOpen = goal !== null && !result.stopped
    // A turn can also end cleanly while it was plainly still working. The
    // provider loop stops the moment the model emits no tool call, which is not
    // the same as the model being finished — observed four times on one request,
    // most recently as "Now let me read the specific sections I need to fix"
    // followed by nothing.
    //
    // Known blind spot, deliberately left alone: `ChatRequest.plan` is
    // *conversation*-scoped, so a turn that calls no plan tool inherits
    // whichever plan the previous turn left behind. If that plan is fully
    // completed, `activePlan` returns null and this rescue cannot fire even
    // though the current request may be unrelated and unfinished — observed
    // once, on a turn that stopped mid-edit. The cause there was a tool call
    // the fallback parser could not read (see `toolCallFallback.ts`), which is
    // fixed at its source; widening the rescue to cover a stale completed plan
    // would mean resuming on no evidence at all, which is the signal below
    // that was already tried and reverted.
    //
    // What makes this safe to act on is the *plan*. An unfinished plan is
    // explicit, user-visible state the model wrote itself, saying there is more
    // to do; a question ("why is this black? diagnose only") has no plan at all,
    // which is why continuing on a bare "changed nothing" signal was wrong and
    // was reverted. This reads state, never the request's wording.
    //
    // Bounded, and still gated on `madeProgressThisCycle` below, so a plan left
    // open forever cannot turn every later turn into a multi-cycle run.
    // "Was it actually working?" — a successful call that did something and was
    // not plan bookkeeping. A cycle that only ticked plan rows, or only got a
    // redirect back, has not established that there is work in flight, and
    // resuming it would amplify a turn that achieved nothing.
    const madeRealToolProgress =
      cycleToolCalls?.some(
        (call) => call.status === 'success' && call.madeProgress !== false && call.kind !== 'plan'
      ) ?? false
    const stalledWithOpenPlan =
      !result.stopped &&
      goal === null &&
      currentPlan !== null &&
      madeRealToolProgress &&
      planContinuations < MAX_OPEN_PLAN_CONTINUATIONS
    if (stalledWithOpenPlan) planContinuations++
    const withinGoalDeadline = goalDeadline === null || Date.now() < goalDeadline
    const canContinue =
      (recoveredStop || goalStillOpen || stalledWithOpenPlan) &&
      madeProgressThisCycle &&
      cycle < cycleCeiling - 1 &&
      withinGoalDeadline &&
      !io.signal?.aborted &&
      !contextRecoveryBlocked

    log.info('Bounded cycle ended', {
      cycle,
      cycleCeiling,
      stopReason: result.stopReason ?? null,
      stopped: result.stopped,
      toolCalls: cycleToolCalls?.length ?? 0,
      fixedTokens: result.contextBudget?.fixedTokens ?? null,
      madeProgress: madeProgressThisCycle,
      contextEpoch: contextEpochCount,
      startedContextEpoch,
      continuing: canContinue,
      // Which of the three continuation paths applies, so a split turn says
      // whether it resumed because the provider stopped recoverably, because a
      // goal was still open, or because the visible plan still had rows to do.
      continuationCause: !canContinue
        ? null
        : recoveredStop
          ? 'recoverable-stop'
          : goalStillOpen
            ? 'goal-open'
            : 'open-plan'
    })

    if (!canContinue) {
      if (goal !== null && !goalFinished) {
        goalBlockedReason ??= describeGoalStop({
          aborted: Boolean(io.signal?.aborted),
          outOfTime: !withinGoalDeadline,
          outOfCycles: cycle >= cycleCeiling - 1,
          madeProgress: madeProgressThisCycle,
          recoveryChurn,
          stopped: result.stopped
        })
      } else if (goal === null) {
        chatEndReason = describeChatStop({
          wantedToContinue: recoveredStop || stalledWithOpenPlan,
          planExhausted:
            currentPlan !== null &&
            madeRealToolProgress &&
            planContinuations >= MAX_OPEN_PLAN_CONTINUATIONS,
          outOfCycles: cycle >= cycleCeiling - 1,
          madeProgress: madeProgressThisCycle,
          contextRecoveryBlocked,
          aborted: Boolean(io.signal?.aborted)
        })
      }
      break
    }

    // Without `toolCalls` here, a session rebuild between cycles (proactive
    // or reactive mid-turn compaction, or simply a different conversationId
    // fast path missing) would replay this cycle's assistant turn as bare
    // prose — the model would have no record of which files it already read
    // or what it found, and could report starting "fresh" on the very next
    // cycle despite dozens of completed tool calls. `ToolCall.result` is
    // exactly the field the chat/session-rebuild path already relies on to
    // let a resumed conversation "remember" past tool output — see its doc
    // comment in `tools.types.ts`.
    history = startedContextEpoch
      ? baseHistory
      : [
          ...history,
          { role: 'user', content: prompt },
          sanitizeHistoryTurn({
            role: 'assistant',
            content: result.content,
            toolCalls: cycleToolCalls
          })
        ]
    prompt = goal ? goalContinuePrompt(goal) : CHAT_CONTINUE_PROMPT
  }

  // The loop always runs at least once, so `last` is always assigned —
  // TypeScript can't see that through the `for` loop, hence the assertion.
  const finalResult = last as RunGenerationResult

  // A natural-looking final answer with an untouched plan is a visible trust
  // failure: the user sees “Done” beside rows that say pending. Ask once for
  // a reconciliation, but constrain that extra model pass to status updates
  // and deliberately discard its prose so the user receives one reply, not a
  // confusing second mini-answer.
  if (canReconcilePlan(currentPlan, finalResult, io, [...completedToolCalls.values()])) {
    try {
      const reconciliationHistory = [
        ...history,
        { role: 'user' as const, content: prompt },
        sanitizeHistoryTurn({
          role: 'assistant',
          content: finalResult.content,
          toolCalls: latestCycleToolCalls
        })
      ]
      const reconciliation = await runGeneration(
        {
          ...request,
          history: reconciliationHistory,
          prompt: PLAN_RECONCILIATION_PROMPT,
          context,
          plan: currentPlan
        },
        {
          ...io,
          enabledTools: new Set(['update_plan_step']),
          onToken: undefined,
          onThinkingToken: undefined,
          onActivity: (call) => {
            if (call.status !== 'running') completedToolCalls.set(`plan:${call.id}`, call)
            if (call.plan) currentPlan = activePlan(call.plan)
            io.onActivity?.(call)
          }
        }
      )
      totalTokens += reconciliation.stats.tokens
      totalDurationMs += reconciliation.stats.durationMs
      if (reconciliation.context) context = reconciliation.context
    } catch {
      // The already-completed user task stays intact if this bookkeeping-only
      // pass cannot run (for example, a provider disconnects just afterward).
      // The final note below makes the remaining plan state explicit instead.
    }
  }

  // A turn that ran to a limit never got to write a conclusion: the last thing
  // the user sees is whatever narration the final cycle was mid-way through
  // ("Let me fix that now:"), and the structured account below states what was
  // touched but not what any of it meant. One tool-less pass closes the task in
  // the model's own words. Only for a turn that was cut short — a turn that
  // finished naturally already ended with its own answer.
  if (needsClosingSummary(finalResult, chatEndReason, combinedContent)) {
    try {
      const closing = await runGeneration(
        {
          ...request,
          history: [
            ...history,
            { role: 'user' as const, content: prompt },
            sanitizeHistoryTurn({
              role: 'assistant',
              content: finalResult.content,
              toolCalls: latestCycleToolCalls
            })
          ],
          prompt: CLOSING_SUMMARY_PROMPT,
          context,
          plan: currentPlan
        },
        { ...io, enabledTools: new Set(), onToken: undefined, onThinkingToken: undefined }
      )
      totalTokens += closing.stats.tokens
      totalDurationMs += closing.stats.durationMs
      if (closing.context) context = closing.context
      const summary = closing.content.trim()
      if (summary) combinedContent = `${combinedContent}\n\n${summary}`
    } catch {
      // Losing the closing words must not lose the work: the structured account
      // below still reports what the turn actually did.
    }
  }

  const stats: GenerationStats = {
    tokens: totalTokens,
    durationMs: totalDurationMs,
    tokensPerSecond: totalDurationMs > 0 ? (totalTokens / totalDurationMs) * 1000 : 0
  }

  // Checked once, against the fully combined reply — a fabrication in any
  // cycle's contribution is still a fabrication in the final answer the user
  // sees. See `findUnverifiedPathClaims`'s doc comment for the exact live
  // failure this catches (a synthesis cycle that made zero new tool calls
  // inventing a plausible-looking file/line-range table).
  const unverifiedPaths = await findUnverifiedPathClaims(
    combinedContent,
    workspaceRoot,
    ledger.reads
  )
  // The fabrication signal the unattended surfaces show (`AgentRun.flaggedTurns`,
  // the Scheduler flag, the model reliability score) now comes from here.
  //
  // It used to come from a set of phrase detectors asking whether the reply
  // *sounded* like it was claiming work — "I've added…", "I fixed…" — which
  // decided a durable reliability penalty from the model's writing style. This
  // is the same question answered from state: the reply named workspace files,
  // and this task neither read nor wrote them and they are not on disk. A
  // wording change cannot create or hide it.
  if (unverifiedPaths.length > 0) {
    fabricationDetectedAnyCycle = true
    const model = llamaService.getState().model
    if (model) {
      modelReliabilityStore.recordFabrication(model.id, model.name, basename(model.path))
    }
  }
  // One account of the turn, from the settled record, rather than six separate
  // disclaimers. A reply that was cut short used to end in a wall of warnings
  // with no statement of what had actually happened; this states the work
  // first and the caveats after it, and — unlike a model-written summary — it
  // cannot describe something that never occurred. See `describeTurnOutcome`.
  const outcome = describeTurnOutcome({
    calls: [...completedToolCalls.values()],
    plan: currentPlan,
    stopped: finalResult.stopped,
    blockedGathering: ledger.blockedGathering,
    unverifiedPaths,
    endedBecause: chatEndReason
  })
  const finalContent = `${combinedContent}${outcome ?? ''}`

  return {
    ...finalResult,
    content: finalContent,
    turnOutcome: outcome ?? undefined,
    stats,
    stopped: recoveryChurnDetected || finalResult.stopped,
    stopReason: recoveryChurnDetected ? 'no-progress' : finalResult.stopReason,
    goalOutcome:
      goal === null
        ? undefined
        : goalFinished
          ? { status: 'finished', summary: goalSummary }
          : { status: 'unfinished', blockedReason: goalBlockedReason ?? undefined },
    thinking: combinedThinking || undefined,
    fabricationDetected: fabricationDetectedAnyCycle,
    memoryUsed: memoryUsed.length > 0 ? memoryUsed : undefined,
    transcriptRecallUsed: transcriptRecallUsed.length > 0 ? transcriptRecallUsed : undefined,
    webSources: webSources.list(),
    webSearchAttempted: webSources.attempted,
    context
  }
}

/**
 * Whether the reply was cut short mid-thought and so owes the user a closing
 * word. Two ways that happens, and `chatEndReason` alone only catches the first:
 *
 * 1. The loop wanted to keep going and was not allowed to — a limit, churn, a
 *    blocked recovery. `chatEndReason` records exactly that.
 * 2. The model simply stopped. This exit is *clean* — nothing is `stopped`, no
 *    reason is recorded — so it used to pay for no closing pass at all, and it
 *    is the ending that has actually reached users: "Now let me inspect the
 *    page to see if the sandbox renders.", a command, then silence. Gating it
 *    on `endedOnToolCall` reads the shape of the ending rather than its
 *    wording: the model never came back to comment on its own last tool result.
 *
 * A user Stop is neither — they know why it ended and asked for it to be over,
 * not for one more model pass.
 */
function needsClosingSummary(
  result: RunGenerationResult,
  endedBecause: string | null,
  content: string
): boolean {
  if (result.stopReason === 'user') return false
  if (content.trim().length === 0) return false
  return endedBecause !== null || result.endedOnToolCall === true
}

function goalStillOpenFor(result: RunGenerationResult, goal: string | null): boolean {
  return goal !== null && !result.stopped
}

/**
 * Identifies completed work without retaining full tool output in the
 * cross-cycle ledger. Titles include the effective command/path for the
 * workspace tools; the short result suffix distinguishes a real changed read
 * from a repeated read after a mutation.
 */
function toolActivityKey(call: ToolCall, epoch: number): string {
  return JSON.stringify({
    // A context epoch drops evidence the model still needs, and the handoff
    // explicitly authorizes reopening some of it. Keyed without the epoch, that
    // authorized re-read produces a key seen before, reads as "no novel tool
    // activity", and terminates the run on the very action the epoch asked for.
    epoch,
    ...toolActivityFacts(call)
  })
}

/**
 * The same facts *without* the epoch — what makes two calls the same work.
 *
 * The epoch in `toolActivityKey` buys back one authorized re-read, but on its
 * own it hands out a fresh key every epoch, so unlimited repetition keeps
 * reading as novel and the no-progress guard is disabled in exactly the
 * situation it exists for. A measured run made 181 calls of which 86 were exact
 * repeats — one command ran ten times — while every cycle still reported
 * progress, and it ran 42 minutes to the cycle ceiling.
 *
 * `result` is part of the identity, so a re-read that returns something
 * different is genuinely new work and is unaffected; only a call that returns
 * what it returned before is counted as a repeat.
 */
function repeatedCallIdentity(call: ToolCall): string {
  return JSON.stringify(toolActivityFacts(call))
}

function toolActivityFacts(call: ToolCall): Record<string, unknown> {
  return {
    name: call.name,
    title: call.title,
    status: call.status,
    touchedPaths: call.touchedPaths?.slice().sort(),
    result: call.result?.slice(0, 512),
    detail: call.status === 'error' || call.status === 'denied' ? call.detail : undefined
  }
}

function buildContextEpochHandoff(input: {
  epoch: number
  cause: ContextEpochHandoff['cause']
  objective: string
  plan: ChatRequest['plan'] | null | undefined
  calls: ToolCall[]
  workingSummary?: string
  evidenceIndex?: string
  priorFixedTokens?: number
}): ContextEpochHandoff {
  const settledCalls = input.calls.filter(
    (call): call is ToolCall & { status: 'success' | 'error' | 'denied' } =>
      call.status === 'success' || call.status === 'error' || call.status === 'denied'
  )
  const completedTools = selectContextEpochCalls(settledCalls).map((call) => ({
    name: call.name,
    kind: call.kind,
    status: call.status,
    ...(call.madeProgress === false ? { madeProgress: false } : {}),
    touchedPaths: call.touchedPaths?.slice(0, 4),
    identity: toolCallIdentity(call),
    outcome: call.detail?.trim() ? call.detail.trim().slice(0, 120) : undefined,
    contentHash: writtenContentHash(call)
  }))
  return {
    version: 1,
    id: randomUUID(),
    createdAt: Date.now(),
    epoch: input.epoch,
    cause: input.cause,
    objective: input.objective,
    workingSummary: input.workingSummary,
    evidenceIndex: input.evidenceIndex,
    plan: input.plan ?? undefined,
    completedTools,
    // Derived in `turnProgress.ts` from the same kind sets the live gate uses,
    // so an epoch can never disagree with `agentTools.ts` about what counts as
    // work or as a rendering-affecting change.
    progress: progressFromSettledCalls(input.calls.map(asProgressCall)),
    priorFixedTokens: input.priorFixedTokens,
    verificationNote:
      'Preserve the existing evidence gate: after a rendering-affecting change, inspect the result again before claiming success.'
  }
}

/**
 * Keep the latest settlements while reserving room for recent durable work.
 * Error/no-op churn used to evict every earlier mutation from a 12-call
 * handoff, making the fresh epoch repeat work it had genuinely completed.
 */
function selectContextEpochCalls<T extends ToolCall>(calls: readonly T[]): T[] {
  const durableLimit = 6
  const recentOtherLimit = 2
  const evidenceLimit = 4
  const durable = (call: T): boolean =>
    call.status === 'success' &&
    call.madeProgress !== false &&
    !isReadLikeCall(call) &&
    call.kind !== 'plan'
  const selected = new Set(calls.filter(durable).slice(-durableLimit))
  const visual = calls.findLast(
    (call) => call.name === 'inspect_visual' && call.status === 'success'
  )
  if (visual) selected.add(visual)

  const evidenceKeys = new Set<string>()
  let evidenceCount = visual ? 1 : 0
  for (const call of calls.toReversed()) {
    if (evidenceCount >= evidenceLimit) break
    if (!isReadLikeCall(call) || call.status !== 'success' || call === visual) continue
    const key = readEvidenceKey(call)
    if (evidenceKeys.has(key)) continue
    evidenceKeys.add(key)
    selected.add(call)
    evidenceCount++
  }

  for (const call of calls
    .filter((call) => !durable(call) && !(isReadLikeCall(call) && call.status === 'success'))
    .slice(-recentOtherLimit)) {
    selected.add(call)
  }
  return calls.filter((call) => selected.has(call))
}

function readEvidenceKey(call: ToolCall): string {
  const path = call.touchedPaths?.[0]?.toLowerCase()
  if (path) {
    const category = call.name === 'inspect_visual' ? 'visual' : 'file'
    return `${category}:${path}`
  }
  return `${call.name}:${call.title.toLowerCase().replace(/\d+/g, '#')}`
}

/**
 * What this bounded reply is trying to achieve, carried across context epochs.
 *
 * The standing goal when there is one, otherwise the request exactly as the
 * user typed it. Anodex used to inspect the wording for "vague follow-up"
 * phrasing and splice earlier user turns into the objective when it matched,
 * which made what a recovery resumed depend on the user's choice of words: a
 * phrasing the pattern missed produced a different objective than one it
 * caught, for the same intent. The preceding turns are still in
 * `request.history`; they do not need a regex to promote them.
 */
function buildRecoveryObjective(request: ChatRequest, goal: string | null): string {
  return goal ?? request.prompt.trim()
}

/**
 * The model's own conclusions from this reply so far, carried into the next
 * epoch: the newest few distinct paragraphs, verbatim.
 *
 * An earlier version tried to strip "process narration" ("Let me check…") with
 * phrase patterns. That made what survived a recovery depend on wording, and it
 * truncated a paragraph mid-sentence whenever a matched phrase happened to
 * follow a real finding. Deduplicated and bounded is enough — a little
 * narration costs a few tokens, while a dropped conclusion costs the work that
 * produced it. The epoch's factual content comes from the settlement list and
 * the evidence index rendered beside this, not from here.
 */
function buildRecoveryWorkingSummary(content: string): string | undefined {
  const unique = new Set<string>()
  const substantive: string[] = []
  for (const raw of content.split(/\n{2,}/)) {
    const paragraph = raw.trim().replace(/\s+/g, ' ')
    if (!paragraph) continue
    const key = paragraph.toLowerCase()
    if (unique.has(key)) continue
    unique.add(key)
    substantive.push(paragraph)
  }
  if (substantive.length === 0) return undefined
  return substantive.slice(-4).join('\n')
}

/** A completed plan is UI history, not active model state for a later request. */
function activePlan(
  plan: ChatRequest['plan'] | null | undefined
): NonNullable<ChatRequest['plan']> | null {
  if (!plan || plan.steps.length === 0) return null
  return plan.steps.some((step) => step.status !== 'completed') ? plan : null
}

/**
 * Some local models use the shell for ordinary reads. Preserve the command's
 * approval behavior, but classify its task effect from Anodex's own recorded
 * title so read-only PowerShell/CLI queries do not masquerade as mutations in
 * recovery, visual-verification, or progress state.
 */
function isReadLikeCall(call: Pick<ToolCall, 'name' | 'kind' | 'title'>): boolean {
  return call.kind === 'read' || isObservationalRunCommand(call)
}

function asProgressCall(call: ToolCall): ToolCall {
  return isObservationalRunCommand(call) ? { ...call, kind: 'read' } : call
}

function recoveryReadIdentity(call: ToolCall): string {
  if (call.name === 'run_command' && call.title.startsWith('Run: ')) {
    return `run_command:${observationalCommandIdentity(call.title.slice('Run: '.length))}`
  }
  return `${call.name}:${call.title}`.toLowerCase().replace(/\s+/g, ' ').trim()
}

function settleInterruptedReadCalls(
  toolCallsById: Map<string, ToolCall>,
  completedToolCalls: Map<string, ToolCall>,
  cycle: number,
  io: RunGenerationIo
): void {
  for (const [id, call] of toolCallsById) {
    if (call.status !== 'running' || !isReadLikeCall(call)) continue
    const settled: ToolCall = {
      ...call,
      status: 'error',
      detail: 'Stopped before this read finished',
      madeProgress: false
    }
    toolCallsById.set(id, settled)
    completedToolCalls.set(`${cycle}:${id}`, settled)
    io.onActivity?.(settled)
  }
}

/**
 * The one-line identity of a settled call.
 *
 * `ToolCall.title` is authoritative — `parseRunCommandVerification` already
 * parses the command back out of it — and it is a settlement-time snapshot, so
 * the in-turn argument reclamation that rewrites the provider message array
 * cannot have truncated it first.
 */
function toolCallIdentity(call: ToolCall): string | undefined {
  const title = call.title?.trim()
  return title ? title.slice(0, 200) : undefined
}

/**
 * Digest of what a successful write actually left on disk, so a resumed epoch
 * can recognize its own completed work rather than redo it. Deliberately not
 * the content: the handoff carries facts, and the file itself is still there.
 */
function writtenContentHash(call: ToolCall): string | undefined {
  if (call.status !== 'success' || !call.diff) return undefined
  return createHash('sha256').update(call.diff.after).digest('hex').slice(0, 12)
}

function normalizeCycleContent(content: string): string {
  return content.trim().replace(/\s+/g, ' ')
}

/**
 * Whether the bookkeeping-only reconciliation pass should run.
 *
 * The `toolCalls` condition is what stops this pass amplifying a turn that
 * achieved nothing. Reconciliation exists to close the gap between finished
 * work and a plan whose rows still say pending, so it presupposes that durable
 * work actually happened: a read can inform an answer, but it cannot prove an
 * implementation step advanced. In chat
 * `c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef` one read followed by "Let me ... fix
 * it" launched an 11-call plan-only pass over an older plan.
 *
 * The gate is entirely the settled calls now. It used to additionally require
 * the reply to *sound* finished, which decided a bookkeeping pass from the
 * model's choice of words and skipped it whenever a genuinely complete turn
 * happened to end on a caveat. Durable work plus an open plan step is the whole
 * condition; the reconciliation prompt itself already refuses to tick a step the
 * completed work does not support.
 */

function canReconcilePlan(
  plan: ChatRequest['plan'] | null | undefined,
  result: RunGenerationResult,
  io: RunGenerationIo,
  toolCalls: ToolCall[]
): boolean {
  const didDurableWork = toolCalls.some(isDurableChange)
  return Boolean(
    !result.stopped &&
    !io.signal?.aborted &&
    didDurableWork &&
    plan?.steps.some((step) => step.status !== 'completed') &&
    (io.enabledTools == null || io.enabledTools.has('update_plan_step'))
  )
}

/**
 * Why a chat turn stopped continuing — `null` when it simply finished
 * answering, which needs no explanation.
 *
 * The distinction that matters is `wantedToContinue`: the ordinary end of a
 * chat turn is the model finishing its reply, and announcing a "reason" for
 * that would be noise on every well-behaved turn. This speaks only when the
 * turn was mid-flight and something denied it another round.
 */
function describeChatStop(reason: {
  wantedToContinue: boolean
  planExhausted: boolean
  outOfCycles: boolean
  madeProgress: boolean
  contextRecoveryBlocked: boolean
  aborted: boolean
}): string | null {
  // The user pressed stop; they do not need to be told what they just did.
  if (reason.aborted) return null
  if (!reason.wantedToContinue && !reason.planExhausted) return null
  if (reason.contextRecoveryBlocked) {
    return 'it ran out of room to recover what it had already read. Say "continue" to resume with a fresh context.'
  }
  if (reason.outOfCycles) {
    return `it reached the limit of ${MAX_CYCLES} tool-calling rounds for a single reply. Say "continue" to resume.`
  }
  if (!reason.madeProgress) {
    return 'the last round added nothing new, so it stopped rather than repeat itself.'
  }
  if (reason.planExhausted) {
    return `it resumed ${MAX_OPEN_PLAN_CONTINUATIONS} times with plan steps still open and will not resume itself again. Say "continue" to keep going.`
  }
  return 'it stopped mid-task. Say "continue" to resume.'
}

function describeGoalStop(reason: {
  aborted: boolean
  outOfTime: boolean
  outOfCycles: boolean
  madeProgress: boolean
  recoveryChurn?: boolean
  stopped: boolean
}): string {
  if (reason.aborted) return 'Stopped by you.'
  if (reason.outOfTime) return 'Reached the time budget for one goal run. Say "continue" to resume.'
  if (reason.outOfCycles) {
    return 'Reached the step budget for one goal run. Say "continue" to resume.'
  }
  // Distinct from "made no new progress": the model *did* act, it just spent
  // consecutive cycles reopening material instead of continuing the task, and
  // telling the user it did nothing would be untrue.
  if (reason.recoveryChurn) {
    return 'After recovering context it kept re-reading the same material instead of continuing, so it stopped.'
  }
  if (!reason.madeProgress) {
    return 'The last step made no new progress, so it stopped rather than repeat itself.'
  }
  if (reason.stopped) return 'The turn hit a generation limit before the goal was met.'
  return 'Ended without reporting the goal complete.'
}
