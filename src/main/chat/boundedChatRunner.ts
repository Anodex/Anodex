import { createHash, randomUUID } from 'node:crypto'
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
import { createReadCoverageTracker } from '../tools/readCoverage'
import { createLoopGuardState } from '../tools/loopGuard'
import { WebSourceRegistry } from '../tools/WebSourceRegistry'
import {
  describeUnverifiedPathClaims,
  findUnverifiedPathClaims
} from '../tools/pathClaimVerification'
import { parseRunCommandVerification } from '../tools/commandTools'
import { claimsVisualSuccess } from '../tools/visualVerification'
import { progressFromSettledCalls } from '../tools/turnProgress'
import { projectStore } from '../projects/ProjectStore'
import { withEpochHandoff } from '@shared/context.types'

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
 * Commands that count as having actually built, tested, type-checked, or
 * linted something — across every ecosystem Anodex might be pointed at, not
 * just JavaScript.
 *
 * This gates `describeMissingBuildVerification`, which appends "no build,
 * test, type-check, or lint command completed in this task" to a reply that
 * diagnoses a build problem. Getting the list wrong is not a cosmetic miss: a
 * C++ developer whose `make test` passed, or a Ruby developer whose `rspec`
 * ran green, was told their verified fix was unverified. That is Anodex's own
 * honesty machinery producing a false accusation, and it fired only for
 * non-JavaScript projects — precisely the users least served by the rest of
 * the tooling.
 *
 * Grouped by ecosystem so a missing entry is easy to spot and add. Erring
 * toward inclusion is right here: a false *negative* (a real verification not
 * recognized) actively misinforms, while a false positive merely omits a note.
 */
const BUILD_OR_TEST_TOOLS = [
  // JavaScript / TypeScript
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'deno',
  'vitest',
  'jest',
  'mocha',
  'jasmine',
  'playwright',
  'cypress',
  'tsc',
  'eslint',
  'biome',
  // Python
  'pytest',
  'unittest',
  'tox',
  'nox',
  'mypy',
  'pyright',
  'ruff',
  'pylint',
  'flake8',
  'poetry',
  'hatch',
  // Rust
  'cargo',
  'rustc',
  'clippy',
  // Go
  'go',
  'gofmt',
  'golangci-lint',
  // JVM
  'gradle',
  'gradlew',
  'mvn',
  'maven',
  'ant',
  'sbt',
  'lein',
  // .NET
  'dotnet',
  'msbuild',
  'nunit',
  'xunit',
  // C / C++ and general native build systems
  'make',
  'cmake',
  'ctest',
  'ninja',
  'meson',
  'bazel',
  'buck',
  'clang',
  'gcc',
  // Apple platforms
  'swift',
  'xcodebuild',
  'xcrun',
  // Ruby
  'rake',
  'rspec',
  'minitest',
  'bundle',
  // PHP
  'composer',
  'phpunit',
  'pest',
  // Dart / Flutter
  'dart',
  'flutter',
  // Others
  'zig',
  'mix',
  'stack',
  'cabal',
  'nimble',
  'crystal',
  'scons'
]

/**
 * `clang++`/`g++` are matched separately: `+` is not a word character, so a
 * trailing word boundary after them would never match.
 */
const BUILD_OR_TEST_COMMAND = new RegExp(
  // String.raw, not a plain template literal: `\b` in a normal template
  // literal is the backspace escape, so the pattern would silently lose every
  // word boundary and match substrings inside unrelated words.
  String.raw`(?:\b(?:${BUILD_OR_TEST_TOOLS.join('|')})\b|\b(?:clang|g)\+\+)`,
  'i'
)

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
 * Cycle ceiling for a goal run (`ChatRequest.goal`), which continues on
 * *unfinished work* rather than only on a recoverable stop and so needs its own
 * bound. Higher than `MAX_CYCLES` because finishing a real goal legitimately
 * takes more turns than recovering from a budget stop, but still finite: a goal
 * that cannot be reached in this many cycles is reported unfinished rather than
 * run forever.
 */
const GOAL_MAX_CYCLES = 40
/** Context recovery has its own smaller ceiling than ordinary goal cycles. */
const MAX_CONTEXT_EPOCHS_PER_REPLY = 3

/**
 * Consecutive post-epoch cycles that may consist only of reading before the run
 * stops. One is expected and useful — the epoch deliberately dropped evidence
 * and told the model to reopen it. Two in a row means the reopening has become
 * the work, which would otherwise ride the whole goal-cycle budget without
 * producing anything.
 */
const MAX_CONSECUTIVE_RECOVERY_ONLY_CYCLES = 2

/**
 * Files a single epoch may reopen despite existing read coverage.
 *
 * Small on purpose. The allowance exists because an epoch drops evidence the
 * tracker still counts as read; it is not a licence to re-read the workspace,
 * which is the churn `ReadCoverageTracker` was built to stop.
 */
const RECOVERY_READS_PER_EPOCH = 3

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
  const readCoverage = createReadCoverageTracker()
  const loopGuard = io.loopGuard ?? createLoopGuardState()
  // Same resolution `runGeneration` itself uses internally — needed here too
  // so the final reply can be checked against real disk/coverage state (see
  // `findUnverifiedPathClaims`), not just handed straight to the caller.
  const projects = projectStore.getState()
  const requestProjectId =
    'projectId' in request ? (request.projectId ?? null) : projects.activeProjectId
  const workspaceRoot =
    projects.projects.find((project) => project.id === requestProjectId)?.folderPath ?? null
  let history: ChatHistoryTurn[] = request.history
  let prompt = request.prompt
  let context = request.context ?? undefined
  // Plan state is separate from compacted transcript history. Carry the latest
  // tool-emitted snapshot into every continuation cycle so a fresh context
  // epoch can still update the same visible plan.
  let currentPlan = request.plan ?? null
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
  const seenCycleContent = new Set<string>()
  const completedToolCalls = new Map<string, ToolCall>()
  let latestCycleToolCalls: ToolCall[] | undefined

  // A standing `/goal` turns this into a goal run: it keeps taking cycles
  // while real progress continues, and ends when the model calls `finish_goal`
  // (which the evidence gate in `agentTools.ts` can refuse) rather than after
  // one pass. See `ChatRequest.goal`.
  const goal = request.goal?.trim() || null
  const originalObjective = goal ?? request.prompt
  const goalDeadline = goal ? Date.now() + GOAL_MAX_TOTAL_MS : null
  const cycleCeiling = goal ? GOAL_MAX_CYCLES : MAX_CYCLES
  let goalFinished = false
  let goalBlockedReason: string | null = null
  let goalSummary: string | undefined
  let contextEpoch: ContextEpochHandoff | undefined
  let contextEpochCount = 0
  let recoveryOnlyCycles = 0

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
        readCoverage,
        loopGuard,
        webSources,
        onActivity: (call) => {
          if (call.status !== 'running') {
            const activityKey = toolActivityKey(call, contextEpochCount)
            if (!seenToolActivity.has(activityKey)) {
              seenToolActivity.add(activityKey)
              novelToolActivityThisCycle = true
            }
            completedToolCalls.set(`${cycle}:${call.id}`, call)
          }
          if (call.plan) currentPlan = call.plan
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
    const recoveryOnlyCycle = Boolean(
      contextEpoch &&
      cycleToolCalls?.length &&
      cycleToolCalls.every((call) => call.kind === 'read') &&
      !novelVisibleContent
    )
    recoveryOnlyCycles = recoveryOnlyCycle ? recoveryOnlyCycles + 1 : 0
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

    const recoveredStop =
      result.stopped &&
      isRecoverableGenerationStop(result.stopReason) &&
      result.stopReason !== 'loop-guard'
    const contextRecovery = result.stopReason === 'context-limit'
    let contextRecoveryBlocked = false
    if (contextRecovery) {
      const nonTerminal = cycleToolCalls?.some((call) => call.status === 'running') ?? false
      if (!nonTerminal && contextEpochCount < MAX_CONTEXT_EPOCHS_PER_REPLY) {
        contextEpochCount++
        contextEpoch = buildContextEpochHandoff({
          epoch: contextEpochCount,
          cause: result.contextEpochCause ?? 'in-turn',
          objective: originalObjective,
          plan: currentPlan,
          calls: [...completedToolCalls.values()],
          priorFixedTokens: result.contextBudget?.fixedTokens
        })
        // This epoch is about to drop evidence out of the model's active
        // context while `readCoverage` — which spans the whole reply — still
        // records it as read. Opening the matching allowance is what makes the
        // handoff's own "reopen workspace evidence" instruction followable
        // instead of answered with "already read earlier this task".
        readCoverage.beginRecoveryEpoch(contextEpoch.recoveryReadAllowance)
        context = withEpochHandoff(context, contextEpoch)
      } else if (nonTerminal) {
        contextRecoveryBlocked = true
        goalBlockedReason =
          'Anodex stopped before every tool call settled, so it did not create an unsafe recovery checkpoint.'
      } else {
        contextRecoveryBlocked = true
        goalBlockedReason = `This task reached its ${MAX_CONTEXT_EPOCHS_PER_REPLY}-epoch recovery limit without completing.`
      }
    }
    // A goal run also continues through a *clean* finish that did not call
    // finish_goal — that is the autonomy. It still requires real progress, so
    // a cycle that achieved nothing stops here rather than looping.
    const goalStillOpen = goal !== null && !result.stopped
    const withinGoalDeadline = goalDeadline === null || Date.now() < goalDeadline

    const canContinue =
      (recoveredStop || goalStillOpen) &&
      madeProgressThisCycle &&
      cycle < cycleCeiling - 1 &&
      withinGoalDeadline &&
      !io.signal?.aborted &&
      !contextRecoveryBlocked

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
    history = [
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
  let planReconciliationAttempted = false
  if (canReconcilePlan(currentPlan, finalResult, io, [...completedToolCalls.values()])) {
    planReconciliationAttempted = true
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
            if (call.plan) currentPlan = call.plan
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
    readCoverage
  )
  const unverifiedNote = describeUnverifiedPathClaims(unverifiedPaths)
  const buildVerificationNote = describeMissingBuildVerification(combinedContent, [
    ...completedToolCalls.values()
  ])
  const visualVerificationNote = describeMissingVisualVerification(combinedContent, [
    ...completedToolCalls.values()
  ])
  const planReconciliationNote = describeUnfinishedPlan(
    currentPlan,
    planReconciliationAttempted,
    combinedContent
  )
  const finalContent = `${combinedContent}${unverifiedNote ?? ''}${buildVerificationNote ?? ''}${visualVerificationNote ?? ''}${planReconciliationNote ?? ''}`

  return {
    ...finalResult,
    content: finalContent,
    stats,
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
    name: call.name,
    title: call.title,
    status: call.status,
    touchedPaths: call.touchedPaths?.slice().sort(),
    result: call.result?.slice(0, 512),
    detail: call.status === 'error' || call.status === 'denied' ? call.detail : undefined
  })
}

function buildContextEpochHandoff(input: {
  epoch: number
  cause: ContextEpochHandoff['cause']
  objective: string
  plan: ChatRequest['plan'] | null | undefined
  calls: ToolCall[]
  priorFixedTokens?: number
}): ContextEpochHandoff {
  const completedTools = input.calls
    .filter(
      (call): call is ToolCall & { status: 'success' | 'error' | 'denied' } =>
        call.status === 'success' || call.status === 'error' || call.status === 'denied'
    )
    .slice(-12)
    .map((call) => ({
      name: call.name,
      kind: call.kind,
      status: call.status,
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
    plan: input.plan ?? undefined,
    completedTools,
    // Derived in `turnProgress.ts` from the same kind sets the live gate uses,
    // so an epoch can never disagree with `agentTools.ts` about what counts as
    // work or as a rendering-affecting change.
    progress: progressFromSettledCalls(input.calls),
    recoveryReadAllowance: RECOVERY_READS_PER_EPOCH,
    priorFixedTokens: input.priorFixedTokens,
    verificationNote:
      'Preserve the existing evidence gate: after a rendering-affecting change, inspect the result again before claiming success.'
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
 * achieved nothing. Reconciliation exists to close the gap between a finished
 * piece of work and a plan whose rows still say pending — it presupposes that
 * work happened. In chat `c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef` the final
 * reply made one edit and then spent seven of eleven calls rewriting plan
 * statuses, and inviting one more status-only generation on top of that made
 * the churn worse rather than better. If the reply produced no successful
 * non-plan tool call, there is by definition nothing new for a status update
 * to honestly reflect, and the "unfinished plan" note below is the truthful
 * outcome instead.
 */
function canReconcilePlan(
  plan: ChatRequest['plan'] | null | undefined,
  result: RunGenerationResult,
  io: RunGenerationIo,
  toolCalls: ToolCall[]
): boolean {
  const didRealWork = toolCalls.some((call) => call.status === 'success' && call.kind !== 'plan')
  return Boolean(
    !result.stopped &&
    !io.signal?.aborted &&
    didRealWork &&
    plan?.steps.some((step) => step.status !== 'completed') &&
    (io.enabledTools == null || io.enabledTools.has('update_plan_step'))
  )
}

function describeUnfinishedPlan(
  plan: ChatRequest['plan'] | null | undefined,
  reconciliationAttempted: boolean,
  content: string
): string | null {
  if (!reconciliationAttempted || !plan || !claimsTaskCompletion(content)) return null
  const unfinished = plan.steps.filter((step) => step.status !== 'completed')
  if (unfinished.length === 0) return null
  return (
    '\n\nPlan status: this reply reported completion, but the following visible plan step(s) could not be ' +
    `confirmed as complete and remain open: ${unfinished.map((step) => step.title).join('; ')}.`
  )
}

function claimsTaskCompletion(content: string): boolean {
  if (/\b(?:not done|not complete|incomplete|cannot complete|can't complete)\b/i.test(content)) {
    return false
  }
  return /\b(?:done|completed|finished|all set|implemented|fixed|created)\b/i.test(content)
}

function describeMissingBuildVerification(content: string, toolCalls: ToolCall[]): string | null {
  if (!looksLikeBuildDiagnosis(content) || hasBuildOrTestVerification(toolCalls)) return null
  return (
    '\n\nBuild verification note: no build, test, type-check, or lint command completed in this task. ' +
    'Treat the structural diagnosis as an inspection finding, not a verified fix.'
  )
}

/** Tool kinds that can change what a page renders. */
const MUTATING_TOOL_KINDS = new Set(['write', 'command'])

/**
 * Why a goal run ended without `finish_goal`. Shown on the goal bar, so it has
 * to distinguish "you stopped it" from "it ran out of room" from "it could not
 * make further progress" — those call for completely different responses from
 * the user.
 */
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

/**
 * A correction appended when a reply claims a visual fix that no screenshot
 * taken after the last edit actually supports.
 *
 * This is the central honesty gate for the failure in chat
 * `c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef`. The model was asked to "confirm by
 * using vision", called `inspect_visual` once at the *start* of the turn, then
 * edited the file and reported progress without ever looking again. A
 * screenshot taken before an edit says nothing about the state after it, so
 * the ordering — not merely the presence — of the inspection is what matters.
 *
 * Deliberately a correction rather than a hard refusal, matching
 * `findUnverifiedPathClaims` and `describeMissingBuildVerification`: the useful
 * partial work still reaches the user, with the unsupported part named. A hard
 * block would discard honest progress along with the overclaim.
 */
function describeMissingVisualVerification(content: string, toolCalls: ToolCall[]): string | null {
  if (!claimsVisualSuccess(content)) return null

  const lastMutationIndex = toolCalls.findLastIndex(
    (call) => call.status === 'success' && MUTATING_TOOL_KINDS.has(call.kind)
  )
  const inspectedAfterLastChange = toolCalls.some(
    (call, index) =>
      call.name === 'inspect_visual' && call.status === 'success' && index > lastMutationIndex
  )
  if (inspectedAfterLastChange) return null

  const inspectedAtAll = toolCalls.some(
    (call) => call.name === 'inspect_visual' && call.status === 'success'
  )
  const reason =
    lastMutationIndex >= 0 && inspectedAtAll
      ? 'the only successful visual inspection in this reply happened BEFORE the last change was made, so it cannot show the result of that change'
      : 'no successful visual inspection ran in this reply'

  return (
    `\n\nVisual verification note: this reply reports that something now renders or works, but ` +
    `${reason}. Treat that as untested. Call inspect_visual on the affected page — using its ` +
    `sectionId for the specific section in question — after the final edit before relying on it.`
  )
}

function looksLikeBuildDiagnosis(content: string): boolean {
  return (
    /\b(?:build|compile|typecheck|test suite)\b/i.test(content) &&
    /\b(?:fix|fixed|cause|because|problem|issue|diagnos\w*|won't run|will not run|can't run)\b/i.test(
      content
    )
  )
}

function hasBuildOrTestVerification(toolCalls: ToolCall[]): boolean {
  return toolCalls.some((call) => {
    const verification = parseRunCommandVerification(call)
    return verification !== null && BUILD_OR_TEST_COMMAND.test(verification.command)
  })
}
