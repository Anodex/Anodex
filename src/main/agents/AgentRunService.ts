import { IpcChannel } from '@shared/ipc'
import { broadcastToWindows } from '../broadcast'
import type { ChatMessage, GenerationStopReason } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'
import { activeElapsedMs, type AgentRun, type CreateAgentRunRequest } from '@shared/agentRun.types'
import type { ToolCall } from '@shared/tools.types'
import type { PathClaimIssue } from '../tools/pathClaimVerification'
import type { Plan } from '@shared/plan.types'
import { messageToHistoryTurn } from '@shared/chatSanitizer'
import { conversationStore } from '../conversations/ConversationStore'
import { appendBackgroundTurn } from '../conversations/backgroundTurn'
import { showToastWindow } from '../toastWindow'
import { runGeneration } from '../chat/runGeneration'
import { describeTurnOutcome, isDurableChange } from '../chat/turnSummary'
import { AGENT_TURN_BUDGET, turnTimeLimitOverride } from '../chat/GenerationBudget'
import { settingsStore } from '../settings/SettingsStore'
import { createLogger } from '../utils/logger'
import { agentRunStore } from './AgentRunStore'
import {
  buildKickoffPrompt,
  buildPlanningPrompt,
  CONTINUE_PROMPT,
  PLAN_APPROVED_PROMPT,
  PLAN_RETRY_PROMPT
} from './agentPrompts'
import { budgetExceededReason, turnBudgetLeftovers } from './agentBudgets'
import { isRecoverableGenerationStop } from '../chat/recoverableStop'
import {
  assessTurnClaims,
  finishedWithNothingToShow,
  idleRunReason,
  stillUnverified,
  workspaceRootForProject
} from './agentTurnClaims'
import { createTaskLedger, type TaskLedger } from '../tools/taskLedger'
import { headlessConfirm } from '../tools/headlessConfirm'

const log = createLogger('agent-run-service')

/**
 * Tools every agent run gets regardless of what the user picked when
 * creating it — skill discovery and the run's own termination signal.
 */
const ALWAYS_ON_TOOLS = ['find_skill', 'load_skill', 'finish_goal']

/**
 * The tool set an execution turn actually gets: the user's selection from
 * the editor, layered with the always-on tools, plus `update_plan_step` for
 * any run that went through plan review. Exported as a pure function (rather
 * than inlined in `runLoop`) so this is testable without the rest of
 * `AgentRunService`'s IPC/generation machinery — `PLAN_APPROVED_PROMPT`
 * explicitly instructs the model to call `update_plan_step`, but the
 * editor's default tool selection doesn't include it, so without this a
 * plan-reviewed run is told to call a tool that was never registered.
 */
export function buildRunEnabledTools(
  run: Pick<AgentRun, 'enabledTools' | 'requirePlan'>
): Set<string> {
  return new Set([
    ...run.enabledTools,
    ...ALWAYS_ON_TOOLS,
    ...(run.requirePlan ? ['update_plan_step'] : [])
  ])
}

/**
 * Tools available during the planning-only turn(s) of a `requirePlan: true`
 * run — deliberately excludes `finish_goal` and every write/command/web
 * tool, so "propose a plan first" is a structural guarantee, not just a
 * prompt instruction the model could ignore.
 */
const PLANNING_TOOLS = ['find_skill', 'load_skill', 'write_plan']

/**
 * Whether `runLoop` should refuse to start even its first execution turn —
 * checked once, before the loop, in addition to the ordinary post-turn
 * `budgetExceededReason` check already inside it. Two gaps that check alone
 * left open, both stemming from planning turns/tokens (see
 * `runPlanningPhase`) being spent against this same budget before this loop
 * ever runs:
 *
 * - `startTurn > run.maxTurns`: planning alone already used up every
 *   available turn (e.g. `maxTurns: 1` with `requirePlan: true`). The `for`
 *   loop's own bound (`turn <= run.maxTurns`) would then never be true, so it
 *   falls through to the generic "Stopped after N turns without finishing"
 *   message — worded as if N turns of real work had been attempted, when
 *   execution never got to run even once.
 * - token/time budget already exhausted by planning: the post-turn check
 *   only fires *after* a turn's generation completes, so without this, the
 *   first execution turn would still run in full — potentially spending a
 *   lot more before the loop had a chance to stop.
 *
 * Exported as a pure function for the same reason as `buildRunEnabledTools`:
 * testable without the rest of `AgentRunService`'s IPC/generation machinery.
 */
export function runPreflightReason(
  run: Pick<
    AgentRun,
    'limitsEnabled' | 'maxTurns' | 'maxTokens' | 'maxDurationMinutes' | 'createdAt'
  >,
  startTurn: number,
  tokensUsedSoFar: number,
  elapsedMs: number
): string | null {
  if (!run.limitsEnabled) return null
  if (startTurn > run.maxTurns) {
    return (
      `Stopped: the ${run.maxTurns}-turn budget was already used during plan review, ` +
      'before execution could start. Increase the turn limit and try again.'
    )
  }
  return budgetExceededReason(run, tokensUsedSoFar, elapsedMs)
}

/**
 * How often (in turns) a still-running run surfaces a progress toast, regardless of
 * whether `limitsEnabled` is on — this is deliberately unconditional so an unlimited
 * run stays visible without needing to be stopped to find out what it's doing.
 */
const CHECK_IN_EVERY_TURNS = 3

function terminalStopMessage(
  stopReason: GenerationStopReason | undefined,
  stopDetail?: string
): string {
  if (stopReason === 'fixed-context-limit') {
    return 'The run could not start because the model’s fixed instructions and compact tool gateway do not fit in its context window.'
  }
  // Nobody is watching an unattended run, so the two reasons that name a real
  // fault must say so. Both used to land in the generic message below, which
  // reported a provider outage in the same words as an ordinary early finish.
  if (stopReason === 'provider-error') {
    return stopDetail
      ? `Run stopped: the model provider failed. ${stopDetail}`
      : 'Run stopped: the model provider failed.'
  }
  if (stopReason === 'runtime-stalled') {
    return 'Run stopped: the local runtime stopped running the model. Reload the model, then retry.'
  }
  return stopReason === 'user' ? 'Run was stopped by the user.' : 'Run stopped before completion.'
}

/**
 * Runs a single goal-directed agent run to completion in the background: a
 * loop of `runGeneration()` turns, each appended to the run's own persisted
 * `Conversation` (same pattern as `SchedulerService`), until the model calls
 * `finish_goal` (`status: 'done'`), `maxTurns` is exhausted
 * (`status: 'stopped'`), or the run throws (`status: 'error'`). Only one run
 * executes at a time — a simple lock, not a queue, mirroring
 * `SchedulerService`'s existing constraint — so a background run never
 * contends with another run or a foreground chat generation on the local
 * engine.
 */
class AgentRunService {
  private runningRunId: string | null = null
  private activeController: AbortController | null = null

  /**
   * Create the run + its conversation, then start it in the background —
   * either a plan-review turn first (`requirePlan`, the default), or
   * straight into the normal turn loop.
   */
  start(request: CreateAgentRunRequest): AgentRun {
    if (this.runningRunId) throw new Error('Another agent run is currently in progress.')
    const run = agentRunStore.create(request)
    const conversation = this.createConversation(run)
    agentRunStore.update(run.id, { conversationId: conversation.id })
    const started = { ...run, conversationId: conversation.id }
    if (started.requirePlan) {
      void this.runPlanningPhase(started, conversation)
    } else {
      void this.runLoop(started, conversation)
    }
    return agentRunStore.get(run.id)!
  }

  /** Approve a plan awaiting review and resume the run's normal turn loop. */
  approvePlan(runId: string): void {
    const run = agentRunStore.get(runId)
    if (!run) throw new Error('Agent run not found.')
    if (run.status !== 'needs-review') throw new Error('This run is not waiting for plan review.')
    if (this.runningRunId) throw new Error('Another agent run is currently in progress.')
    if (!run.conversationId) throw new Error("This run's conversation could not be found.")
    const conversation = conversationStore.get(run.conversationId)
    if (!conversation) throw new Error("This run's conversation could not be found.")

    const updated = agentRunStore.update(runId, { status: 'running' })
    this.broadcastRunsChanged()
    void this.runLoop(updated, conversation, {
      startTurn: updated.turnsUsed + 1,
      firstPrompt: PLAN_APPROVED_PROMPT
    })
  }

  /** Reject a plan awaiting review — ends the run without executing anything further. */
  rejectPlan(runId: string): void {
    const run = agentRunStore.get(runId)
    if (!run) throw new Error('Agent run not found.')
    if (run.status !== 'needs-review') throw new Error('This run is not waiting for plan review.')
    this.finish(runId, run.conversationId!, 'stopped', null, 'Plan rejected.')
  }

  /** Abort the currently running run, if any. */
  stop(runId: string): void {
    if (this.runningRunId !== runId) throw new Error('That run is not currently active.')
    this.activeController?.abort()
  }

  /** Abort any run in progress — called on app quit. */
  stopAll(): void {
    this.activeController?.abort()
  }

  private async runLoop(
    run: AgentRun,
    conversation: Conversation,
    options?: { startTurn?: number; firstPrompt?: string }
  ): Promise<void> {
    this.runningRunId = run.id
    const controller = new AbortController()
    this.activeController = controller
    log.info('Starting agent run:', run.id, run.goal)
    // Open an execution segment. The budget is measured against time actually
    // spent working, not against `now - createdAt`, so a plan that waited on a
    // human does not arrive here with its budget already spent — see
    // `AgentRun.activeMs`.
    const segment = { activeMs: run.activeMs ?? 0, activeSinceAt: Date.now() }
    const workedMs = (): number => activeElapsedMs(segment)
    agentRunStore.update(run.id, { activeSinceAt: segment.activeSinceAt })

    const enabledTools = buildRunEnabledTools(run)
    // Never touches the user's global `provider.active` setting — see
    // `RunGenerationIo.providerOverride`.
    const providerOverride = { provider: run.provider, model: run.model ?? undefined }
    // One tracker for every turn in this run — see `ReadCoverageTracker`'s
    // doc comment. An agent run already carries tool-call memory correctly
    // turn-over-turn (`runTurn` rebuilds history from the persisted
    // `Conversation`, including `toolCalls`), but nothing tracked *coverage*
    // across turns before this, so a long run could still burn turns/tokens
    // re-reading the same file ranges it already saw several turns back.
    const ledger = createTaskLedger()
    const startTurn = options?.startTurn ?? 1
    let turnsUsed = run.turnsUsed
    /** One provider failure per run is retried rather than ending it. */
    let providerRetryUsed = false
    let tokensUsed = run.tokensUsed
    let plan = run.plan
    let flaggedTurns = run.flaggedTurns
    /** Calls across the whole run that actually changed the workspace. */
    let durableChangesMade = 0
    /** Consecutive turns that made no tool call at all - see `idleRunReason`. */
    let idleTurns = 0
    // Every settled call the run has made, for the account attached to its
    // summary. That account used to be the *last turn's*, which is wrong in
    // both directions once a run has more than one turn: a run that wrote 48
    // files across sixteen turns ended with "Changed nothing - this reply only
    // looked", because its final turn had only re-read a file. The heading on
    // a run summary is read as the run's, so it has to be the run's.
    const runCalls: ToolCall[] = []
    const runUnverifiedPaths: PathClaimIssue[] = []

    try {
      // A plan-reviewed run's planning phase already spent turns/tokens
      // against this exact same budget (see `runPlanningPhase`) before this
      // loop ever starts — see `runPreflightReason`'s doc comment for why
      // that needs a check here, before the loop, and not just the
      // post-turn one already further down.
      let lastOutcome: string | null = null
      // `stopped` and `endedBecause` are deliberately not set here: at run
      // level, *why* the run ended is the `lastError` argument `finish` already
      // receives, and this is the account of *what happened*. Keeping the two
      // apart is why one outcome never carries two explanations.
      // Called exactly once, immediately before the run's record is written:
      // every caller returns straight after. Path claims are settled here
      // rather than per turn, against the coverage the whole run accumulated.
      const runOutcome = (): string | null => {
        const unresolved = stillUnverified(
          runUnverifiedPaths,
          workspaceRootForProject(conversation.projectId),
          ledger
        )
        if (unresolved.length > 0) {
          flaggedTurns += 1
          agentRunStore.update(run.id, { flaggedTurns })
        }
        return (
          describeTurnOutcome({
            calls: runCalls,
            plan,
            stopped: false,
            blockedGathering: ledger.blockedGathering,
            unverifiedPaths: unresolved,
            endedBecause: null
          }) ?? lastOutcome
        )
      }
      const preflightReason = runPreflightReason(run, startTurn, tokensUsed, workedMs())
      if (preflightReason) {
        this.finish(run.id, conversation.id, 'stopped', null, preflightReason)
        return
      }

      for (let turn = startTurn; run.limitsEnabled ? turn <= run.maxTurns : true; turn++) {
        turnsUsed = turn
        const prompt =
          turn === startTurn
            ? (options?.firstPrompt ?? buildKickoffPrompt(run.goal))
            : CONTINUE_PROMPT
        const {
          finished,
          summary,
          outcome,
          stopped,
          stopReason,
          stopDetail,
          tokens,
          plan: nextPlan,
          fabricationDetected,
          durableChanges,
          toolCallsMade,
          calls: turnCalls,
          unverifiedPaths: turnUnverifiedPaths
        } = await this.runTurn(
          conversation,
          prompt,
          enabledTools,
          providerOverride,
          controller.signal,
          plan,
          ledger
        )
        tokensUsed += tokens
        if (nextPlan) plan = nextPlan
        durableChangesMade += durableChanges
        idleTurns = toolCallsMade === 0 ? idleTurns + 1 : 0
        runCalls.push(...turnCalls)
        runUnverifiedPaths.push(...turnUnverifiedPaths)
        // Deliberately not flagged per turn - see `stillUnverified`. A turn that
        // names the file it is about to open has not claimed anything yet, and
        // flagging it accused a correct run of fabricating.
        if (fabricationDetected && turnUnverifiedPaths.length === 0) flaggedTurns += 1
        agentRunStore.update(run.id, { turnsUsed, tokensUsed, plan, flaggedTurns })
        this.broadcastRunsChanged()
        if (outcome) lastOutcome = outcome

        // A provider failure is not always the end of the road. Measured: one
        // run of 29 died this way - a single unparseable tool call at turn 4 of
        // 30, after 22 that parsed fine, with 1.7% of its token budget spent.
        // Re-running the identical task got past that point, so the fault was
        // transient.
        //
        // `provider-error` covers both that and a real outage (a rate limit, an
        // invalid request), and the two are told apart only by the provider's
        // own message. Matching on that text would be fragile and
        // provider-specific, so this does not try: one retry, whatever the
        // cause. A transient fault costs nothing and the run survives; a real
        // outage costs one turn and then ends the run exactly as before.
        if (stopped && stopReason === 'provider-error' && !providerRetryUsed) {
          providerRetryUsed = true
          log.warn('Provider failed on run', run.id, '- retrying once:', stopDetail ?? '')
          continue
        }
        if (stopped && !isRecoverableGenerationStop(stopReason)) {
          // Same reasoning as the budget stop below: a run that ends still owes
          // an account of itself, and this branch is the one that fires when
          // something outside the run breaks. Observed live: a GPU device loss
          // (`vk::Queue::submit: ErrorDeviceLost`) ended a run at turn 9 of 44,
          // and it recorded the driver error and nothing about the eight turns
          // of work that had already landed.
          this.finish(
            run.id,
            conversation.id,
            'stopped',
            runOutcome(),
            terminalStopMessage(stopReason, stopDetail)
          )
          return
        }
        // A recoverable turn-level stop (see `isRecoverableGenerationStop`'s doc
        // comment) only ends *this* turn, not the whole run — falls through
        // to the budget/check-in logic below, same as any other turn.
        if (finished) {
          // Keep the settled record next to the claim. `describeTurnOutcome` is
          // derived from the tool record rather than written by the model — the
          // reason the stopped path below already uses it — and that argument is
          // strongest exactly here, where the model is asserting success.
          //
          // Measured: a run edited `ui.py`, ran the smoke test twice, got `exit
          // 1` both times, wrote "The smoke test failed because `_find_button`
          // is missing" in its own reply, and then finished with "I've completed
          // the implementation of camera bookmarks". The workspace was left
          // broken and the factual account of that turn was discarded in favour
          // of the claim.
          //
          // Nothing is refused: a run that means to stop with a failing test
          // still stops. The reader simply gets both halves.
          // A finish that declares success with an untouched workspace and a
          // plan still full of open steps is a claim the settled record does
          // not support. The run still finishes - this only stops it being
          // presented as an unqualified success.
          if (finishedWithNothingToShow({ durableChanges: durableChangesMade, plan })) {
            flaggedTurns += 1
            agentRunStore.update(run.id, { flaggedTurns })
          }
          this.finish(
            run.id,
            conversation.id,
            'done',
            withSettledOutcome(summary, runOutcome()),
            null
          )
          return
        }

        const idleReason = idleRunReason(idleTurns)
        if (idleReason) {
          this.finish(
            run.id,
            conversation.id,
            'stopped',
            withSettledOutcome(null, runOutcome()),
            idleReason
          )
          return
        }

        if (run.limitsEnabled) {
          const budgetReason = budgetExceededReason(run, tokensUsed, workedMs())
          if (budgetReason) {
            this.finish(run.id, conversation.id, 'stopped', null, budgetReason)
            return
          }
        }

        if (
          turnsUsed % CHECK_IN_EVERY_TURNS === 0 &&
          (!run.limitsEnabled || turnsUsed < run.maxTurns)
        ) {
          this.sendCheckIn(run, conversation, turnsUsed, tokensUsed)
        }
      }
      // A run that spends its budget still owes an account of itself. The
      // model-written `summary` only exists when it called `finish_goal`, and a
      // run that ran out of turns never got there -- so this reported nothing
      // at all, on exactly the runs nobody was watching. Observed live: a run
      // stopped at 20/20 turns having left the workspace with a build error,
      // and said only "Stopped after 20 turns without finishing."
      //
      // `describeTurnOutcome` is derived from the settled tool record rather
      // than written by the model, so it states what happened rather than what
      // was intended, and cannot claim work that did not occur.
      this.finish(
        run.id,
        conversation.id,
        'stopped',
        runOutcome(),
        `Stopped after ${run.maxTurns} turns without finishing. ` +
          turnBudgetLeftovers(run, tokensUsed, workedMs())
      )
    } catch (error) {
      log.error('Agent run failed:', run.id, error)
      const message = error instanceof Error ? error.message : 'Run failed.'
      // A reviewed plan must not die with the turn that failed to execute it.
      // `approvePlan()` only accepts `status: 'needs-review'`, so a terminal
      // 'error' strands the plan and the planning turns that paid for it — the
      // generic "Retry with these settings" action starts a brand new run and
      // re-spends them from scratch. Send the run back for approval instead,
      // with the failure recorded so the card says why it bounced and the user
      // can approve again once it's addressed.
      //
      // This used to be scoped to one specific error: the shared local engine
      // being busy with a foreground chat. That case can no longer arise —
      // `LlamaService.generate()` holds the model lock for the whole turn, so a
      // contending caller waits rather than failing — but every other cause
      // strands the plan in exactly the same way, which is what this now
      // covers. Narrowing it to the one failure anyone had hit was the bug.
      //
      // A deliberate stop is excluded: the user ending their own run is not a
      // failure to recover from, and should stay terminal.
      if (run.requirePlan && run.plan && !controller.signal.aborted) {
        agentRunStore.update(run.id, { status: 'needs-review', lastError: message })
        this.broadcastRunsChanged()
        return
      }
      this.finish(run.id, conversation.id, 'error', null, message)
    } finally {
      // The lock is released first, unconditionally. `agentRunStore.update`
      // throws for a run that no longer exists — deleted while it was
      // generating — and a throw from in here would skip the two assignments
      // below and wedge the service against every future run.
      this.runningRunId = null
      this.activeController = null
      this.bankSegment(run.id, workedMs())
    }
  }

  /**
   * The planning-only phase for a `requirePlan: true` run: one turn (plus one
   * bounded retry if the model didn't call `write_plan`) restricted to
   * `PLANNING_TOOLS`, then normally pauses in `needs-review` for a human to
   * approve or reject via `approvePlan`/`rejectPlan`.
   *
   * Under the `untethered` permission mode, though, there is no "human"
   * step to pause for — every individual tool call an agent run makes
   * already runs unattended regardless of this global setting (see
   * `runTurn`'s `permissionModeOverride: 'untethered'` and its own doc
   * comment on why), so pausing here for a manual click was the one place
   * `requirePlan: true` didn't actually match "fully autonomous." The plan
   * is still generated and shown (`AgentRun.plan`, surfaced in the
   * Workspace Dock) exactly as before; it's just approved immediately
   * instead of waiting.
   */
  private async runPlanningPhase(run: AgentRun, conversation: Conversation): Promise<void> {
    this.runningRunId = run.id
    const controller = new AbortController()
    this.activeController = controller
    log.info('Starting plan review phase for agent run:', run.id, run.goal)
    // Planning is the agent working, so it is banked like any other segment.
    // The wait for approval that follows it is not, which is the whole point of
    // measuring segments rather than `now - createdAt` — see `AgentRun.activeMs`.
    const segment = { activeMs: run.activeMs ?? 0, activeSinceAt: Date.now() }
    agentRunStore.update(run.id, { activeSinceAt: segment.activeSinceAt })

    const planningTools = new Set(PLANNING_TOOLS)
    const providerOverride = { provider: run.provider, model: run.model ?? undefined }
    // See the identical `readCoverage` tracker in `runLoop` — scoped to just
    // the planning phase's own (at most two) turns, not shared with the
    // separate `runLoop` that follows once the plan is approved.
    const ledger = createTaskLedger()
    // Read once, before the try block runs any generation — `runLoop` (via
    // `approvePlan`) re-checks its own preflight budget on the way in, so
    // there's no risk of auto-approving into a run that's actually already
    // out of turns/tokens.
    let autoApprove = false

    try {
      const first = await this.runTurn(
        conversation,
        buildPlanningPrompt(run.goal),
        planningTools,
        providerOverride,
        controller.signal,
        null,
        ledger
      )
      let plan = first.plan
      let turnsUsed = 1
      let tokensUsed = first.tokens
      let flaggedTurns = run.flaggedTurns + (first.fabricationDetected ? 1 : 0)

      // A real user Stop (or any internal stop other than a recoverable
      // turn-level one — see `isRecoverableGenerationStop`) must end the run
      // immediately, not fall through to the retry below — retrying against
      // a signal that's already aborted produces no plan either, and
      // previously reported "Could not produce a plan for review" (status:
      // error) for what was actually a deliberate user action, not a
      // failure. A recoverable stop is exempt: it already produces no plan,
      // so the existing "no plan yet, retry once" logic is the right
      // response either way.
      if (first.stopped && !isRecoverableGenerationStop(first.stopReason)) {
        agentRunStore.update(run.id, { turnsUsed, tokensUsed, flaggedTurns })
        this.finish(
          run.id,
          conversation.id,
          'stopped',
          null,
          terminalStopMessage(first.stopReason, first.stopDetail)
        )
        return
      }

      if (!plan) {
        const retry = await this.runTurn(
          conversation,
          PLAN_RETRY_PROMPT,
          planningTools,
          providerOverride,
          controller.signal,
          null,
          ledger
        )
        turnsUsed = 2
        tokensUsed += retry.tokens
        if (retry.fabricationDetected) flaggedTurns += 1
        if (retry.stopped && !isRecoverableGenerationStop(retry.stopReason)) {
          agentRunStore.update(run.id, { turnsUsed, tokensUsed, flaggedTurns })
          this.finish(
            run.id,
            conversation.id,
            'stopped',
            null,
            terminalStopMessage(retry.stopReason, retry.stopDetail)
          )
          return
        }
        plan = retry.plan
      }

      agentRunStore.update(run.id, { turnsUsed, tokensUsed, flaggedTurns })

      if (!plan) {
        this.finish(run.id, conversation.id, 'error', null, 'Could not produce a plan for review.')
        return
      }

      agentRunStore.update(run.id, { status: 'needs-review', plan, flaggedTurns })
      this.broadcastRunsChanged()
      autoApprove = settingsStore.get().general.permissionMode === 'untethered'
    } catch (error) {
      log.error('Plan review phase failed:', run.id, error)
      this.finish(
        run.id,
        conversation.id,
        'error',
        null,
        error instanceof Error ? error.message : 'Run failed.'
      )
    } finally {
      // Lock first — see the identical ordering in `runLoop`.
      this.runningRunId = null
      this.activeController = null
      this.bankSegment(run.id, activeElapsedMs(segment))
    }

    // Deliberately outside the try/finally above: `approvePlan` re-acquires
    // the same `runningRunId`/`activeController` lock `runPlanningPhase` just
    // released in `finally`, so calling it any earlier — e.g. from inside the
    // try block, before that `finally` has run — would have `runLoop`
    // overwrite the lock and then have this method's own `finally` clobber it
    // right back to null out from under an execution loop that's actually
    // still running.
    //
    // Guarded because `approvePlan` throws — for a run deleted while it was
    // planning, most plausibly — and this whole method is started with `void`,
    // so a throw here is an unhandled rejection in the main process and a run
    // left sitting in `needs-review` that untethered mode promised would never
    // need a click.
    if (!autoApprove) return
    try {
      this.approvePlan(run.id)
    } catch (error) {
      log.error('Could not auto-approve plan for agent run:', run.id, error)
      agentRunStore.update(run.id, {
        lastError: error instanceof Error ? error.message : 'Could not start the approved plan.'
      })
      this.broadcastRunsChanged()
    }
  }

  /**
   * Run one turn, appending it to the conversation, and report whether
   * `finish_goal` fired and the latest plan snapshot, if `write_plan`/
   * `update_plan_step` was called this turn (used by both the planning
   * phase and the normal loop, which seeds `currentPlan` back in so a
   * later `update_plan_step` call continues the same plan object).
   */
  private async runTurn(
    conversation: Conversation,
    prompt: string,
    enabledTools: Set<string>,
    providerOverride: { provider: AgentRun['provider']; model?: string },
    signal: AbortSignal,
    currentPlan: Plan | null,
    ledger: TaskLedger
  ): Promise<{
    finished: boolean
    summary: string | null
    /** A factual account of the turn, derived from the settled tool record. */
    outcome: string | null
    stopped: boolean
    stopReason?: GenerationStopReason
    /** See `GenerateOutcome.stopDetail`'s doc comment. */
    stopDetail?: string
    tokens: number
    plan: Plan | null
    /** See `AgentRun.flaggedTurns`'s doc comment. */
    fabricationDetected: boolean
    /** Settled calls this turn that actually changed the workspace. */
    durableChanges: number
    /** Settled tool calls this turn, of any kind. See `idleRunReason`. */
    toolCallsMade: number
    /** This turn's settled calls, accumulated for the run-level account. */
    calls: ToolCall[]
    /** Paths this turn's reply named but never touched. */
    unverifiedPaths: PathClaimIssue[]
  }> {
    const userMessage: ChatMessage = {
      id: generateId('agent_msg'),
      role: 'user',
      content: prompt,
      createdAt: Date.now()
    }
    const assistantMessageId = generateId('agent_msg')
    const toolCallsById = new Map<string, ToolCall>()

    const result = await runGeneration(
      {
        conversationId: conversation.id,
        messageId: assistantMessageId,
        projectId: conversation.projectId,
        context: conversation.context ?? null,
        history: conversation.messages.map(messageToHistoryTurn),
        prompt,
        plan: currentPlan
      },
      {
        signal,
        enabledTools,
        providerOverride,
        // Same headless approval policy as scheduled tasks — no one is present
        // to click an approval modal on a run's behalf, so `headlessConfirm`
        // fails closed on destructive and human-approval-only calls alike.
        permissionModeOverride: 'untethered',
        executionBudget: {
          ...AGENT_TURN_BUDGET,
          ...turnTimeLimitOverride(settingsStore.get().generation.turnTimeLimitMinutes)
        },
        ledger,
        onActivity: (call) => toolCallsById.set(call.id, call),
        confirm: headlessConfirm
      }
    )

    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: result.content,
      createdAt: Date.now(),
      stats: result.stats,
      contextBudget: result.contextBudget,
      contextAssemblies: result.contextAssembly ? [result.contextAssembly] : undefined,
      memoryUsed: result.memoryUsed,
      thinking: result.thinking,
      toolCalls: toolCallsById.size > 0 ? [...toolCallsById.values()] : undefined
    }
    // A new compacted context snapshot this turn (cloud providers only — see
    // `RunGenerationResult.context`'s doc comment) — without this, no one is
    // present to persist it the way the interactive chat renderer does, so
    // every later turn in this same run would silently re-summarize the same
    // growing history from scratch instead of seeding from what was already
    // compacted.
    if (result.context) conversation.context = result.context

    const calls = [...toolCallsById.values()]
    const finishCall = calls.find(
      (call) => call.name === 'finish_goal' && call.status === 'success'
    )
    // Last successful call that touched the plan (write_plan or
    // update_plan_step) — `Map` iteration preserves call order, and each
    // call has a unique id, so the last match is genuinely the latest state.
    const planCalls = calls.filter((call) => call.status === 'success' && call.plan)
    const latestPlan = planCalls.length > 0 ? (planCalls[planCalls.length - 1].plan ?? null) : null
    // Interactive chat's PlanPanel reads `Conversation.plan`, populated via a
    // renderer event stream a headless run never goes through — set it here
    // too (not just on `AgentRun.plan`) so opening this run's conversation
    // shows the same live plan instead of "No active plan for this session."
    if (latestPlan) conversation.plan = latestPlan

    const saved = appendBackgroundTurn(conversation, [userMessage, assistantMessage])
    // `conversation` is reused by the next turn in this same loop — keep its
    // in-memory `messages` in sync with what was just persisted, which is the
    // merged history rather than this snapshot's, so a turn the user typed
    // into the run's chat is carried into the next turn instead of being
    // dropped from it.
    conversation.messages = saved.messages

    // Both of these used to be hardcoded blanks here, so two signals the run
    // already had were thrown away: the ledger's count of calls it refused, and
    // the check on what the reply claimed. `fabricationDetected` documents
    // itself as something unattended callers "surface afterwards rather than
    // silently reporting success", and this is the unattended caller.
    const claims = await assessTurnClaims(
      result.content,
      workspaceRootForProject(conversation.projectId),
      ledger,
      // Everything the tools actually returned this turn, so a figure the reply
      // quotes as measured can be checked against a real source.
      calls.map((call) => call.result ?? '').join(String.fromCharCode(10))
    )

    return {
      finished: Boolean(finishCall),
      summary: finishCall?.detail ?? null,
      // What this turn actually did, from the settled record. Kept separate
      // from `summary` because that one is the model's own closing statement
      // and only exists when it called `finish_goal`.
      outcome: describeTurnOutcome({
        calls,
        plan: latestPlan,
        stopped: result.stopped,
        blockedGathering: ledger.blockedGathering,
        unverifiedPaths: claims.unverifiedPaths,
        unverifiedMeasurements: claims.unverifiedMeasurements,
        // The agent loop reports its own ending at run level - see
        // `turnBudgetLeftovers` - rather than per turn, so there is nothing
        // truthful to put here.
        endedBecause: null
      }),
      stopped: result.stopped,
      stopReason: result.stopReason,
      stopDetail: result.stopDetail,
      tokens: result.stats.tokens,
      plan: latestPlan,
      fabricationDetected: result.fabricationDetected ?? claims.fabricationDetected,
      durableChanges: calls.filter(isDurableChange).length,
      toolCallsMade: calls.length,
      calls,
      unverifiedPaths: claims.unverifiedPaths
    }
  }

  private finish(
    runId: string,
    conversationId: string,
    status: AgentRun['status'],
    summary: string | null,
    lastError: string | null
  ): void {
    agentRunStore.update(runId, { status, summary, lastError })
    this.broadcastRunsChanged()
    const run = agentRunStore.get(runId)
    showToastWindow({
      title: run?.goal ? truncateTitle(run.goal) : 'Agent run',
      body: summary ?? lastError ?? 'Finished.',
      conversationId
    })
  }

  /**
   * Fires every `CHECK_IN_EVERY_TURNS` turns while a run is still going, so a
   * long or unlimited run stays visible without needing to be stopped to find
   * out what it's doing — same toast mechanism `finish()` uses, just mid-run.
   */
  private sendCheckIn(
    run: AgentRun,
    conversation: Conversation,
    turnsUsed: number,
    tokensUsed: number
  ): void {
    const latest = [...conversation.messages]
      .reverse()
      .find((message) => message.role === 'assistant')
    const snippet = latest
      ? truncate(latest.content.replace(/\s+/g, ' ').trim(), 140)
      : 'Still working.'
    const turnLabel = run.limitsEnabled ? `${turnsUsed}/${run.maxTurns}` : String(turnsUsed)
    showToastWindow({
      title: `${truncateTitle(run.goal)} — checking in`,
      body: `Turn ${turnLabel} · ${tokensUsed.toLocaleString()} tokens\n${snippet}`,
      conversationId: conversation.id
    })
  }

  private createConversation(run: AgentRun): Conversation {
    const conversation: Conversation = {
      id: generateId('agent_conv'),
      projectId: run.projectId,
      title: truncateTitle(run.goal),
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      origin: 'agent'
    }
    conversationStore.save(conversation)
    return conversation
  }

  /**
   * Close the current work segment: fold its elapsed time into `activeMs` and
   * clear `activeSinceAt`, so the next segment resumes from a banked total and
   * a live view stops adding in-flight time.
   *
   * Failure here is swallowed on purpose. This runs from a `finally` whose job
   * is releasing the run lock, and the one way it fails — the run having been
   * deleted mid-flight — is a case where there is nothing left to record
   * against. Losing a duration figure for a run that no longer exists is not
   * worth taking down the service that has already released its lock.
   */
  private bankSegment(runId: string, workedMs: number): void {
    try {
      agentRunStore.update(runId, { activeMs: workedMs, activeSinceAt: null })
      this.broadcastRunsChanged()
    } catch (error) {
      log.warn('Could not record worked time for agent run:', runId, error)
    }
  }

  private broadcastRunsChanged(): void {
    broadcastToWindows(IpcChannel.Agent.runsChanged, agentRunStore.list())
  }
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function truncateTitle(text: string): string {
  const firstLine = text.trim().split('\n')[0] ?? ''
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine || 'Agent run'
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}

export const agentRunService = new AgentRunService()

/**
 * Join a run's own summary to the factual account of its last turn.
 *
 * Exported for its own tests: the case that matters is a summary claiming
 * success beside a record showing a failing command, and that pairing should be
 * checkable without driving a whole run.
 */
export function withSettledOutcome(summary: string | null, outcome: string | null): string | null {
  const claim = summary?.trim() ?? ''
  const settled = outcome?.trim() ?? ''
  if (!settled) return summary
  if (!claim) return settled
  if (claim.includes(settled)) return claim
  return `${claim}\n\n${settled}`
}
