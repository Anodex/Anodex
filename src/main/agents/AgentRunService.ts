import { BrowserWindow } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { ChatMessage } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'
import type { AgentRun, CreateAgentRunRequest } from '@shared/agentRun.types'
import type { ToolCall } from '@shared/tools.types'
import type { Plan } from '@shared/plan.types'
import { messageToHistoryTurn } from '@shared/chatSanitizer'
import { conversationStore } from '../conversations/ConversationStore'
import { showToastWindow } from '../toastWindow'
import { runGeneration } from '../chat/runGeneration'
import { GENERATION_IN_PROGRESS_ERROR } from '../llama/LlamaService'
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
import { budgetExceededReason } from './agentBudgets'

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
    const conversation = conversationStore.listAll().find((c) => c.id === run.conversationId)
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

    const enabledTools = buildRunEnabledTools(run)
    // Never touches the user's global `provider.active` setting — see
    // `RunGenerationIo.providerOverride`.
    const providerOverride = { provider: run.provider, model: run.model ?? undefined }
    const startTurn = options?.startTurn ?? 1
    let turnsUsed = run.turnsUsed
    let tokensUsed = run.tokensUsed
    let plan = run.plan
    let flaggedTurns = run.flaggedTurns

    try {
      // A plan-reviewed run's planning phase already spent turns/tokens
      // against this exact same budget (see `runPlanningPhase`) before this
      // loop ever starts — see `runPreflightReason`'s doc comment for why
      // that needs a check here, before the loop, and not just the
      // post-turn one already further down.
      const preflightReason = runPreflightReason(
        run,
        startTurn,
        tokensUsed,
        Date.now() - run.createdAt
      )
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
          stopped,
          stopReason,
          tokens,
          plan: nextPlan,
          fabricationDetected
        } = await this.runTurn(
          conversation,
          prompt,
          enabledTools,
          providerOverride,
          controller.signal,
          plan
        )
        tokensUsed += tokens
        if (nextPlan) plan = nextPlan
        if (fabricationDetected) flaggedTurns += 1
        agentRunStore.update(run.id, { turnsUsed, tokensUsed, plan, flaggedTurns })
        this.broadcastRunsChanged()

        if (stopped && stopReason !== 'loop-guard') {
          this.finish(run.id, conversation.id, 'stopped', null, 'Run was stopped.')
          return
        }
        // A loop-guard trip (a call kept repeating after being blocked — see
        // `LOOP_GUARD_ABORT_AFTER` in `loopGuard.ts`) only ends *this* turn,
        // not the whole run: the guard's state is per-generation, so the next
        // turn starts with a clean slate and a genuine chance to make
        // progress, rather than the run dying over one bad turn. Falls
        // through to the budget/check-in logic below, same as any other turn.
        if (finished) {
          this.finish(run.id, conversation.id, 'done', summary, null)
          return
        }

        if (run.limitsEnabled) {
          const budgetReason = budgetExceededReason(run, tokensUsed, Date.now() - run.createdAt)
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
      this.finish(
        run.id,
        conversation.id,
        'stopped',
        null,
        `Stopped after ${run.maxTurns} turns without finishing.`
      )
    } catch (error) {
      log.error('Agent run failed:', run.id, error)
      // The shared local engine was busy with something else (e.g. the user
      // mid-chat elsewhere) when this run's turn tried to generate — not a
      // real failure of the run itself. For a plan-reviewed run specifically,
      // landing this in a terminal 'error' would be unrecoverable:
      // approvePlan() only accepts status === 'needs-review', so the already
      // -reviewed plan and its planning tokens would be stranded with no way
      // back (the generic "Retry with these settings" action creates a brand
      // new run and re-spends the planning turn(s) from scratch). Revert to
      // needs-review instead so the user can just approve again once the
      // engine is free.
      if (
        error instanceof Error &&
        error.message === GENERATION_IN_PROGRESS_ERROR &&
        run.requirePlan &&
        run.plan
      ) {
        agentRunStore.update(run.id, { status: 'needs-review' })
        this.broadcastRunsChanged()
        return
      }
      this.finish(
        run.id,
        conversation.id,
        'error',
        null,
        error instanceof Error ? error.message : 'Run failed.'
      )
    } finally {
      this.runningRunId = null
      this.activeController = null
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

    const planningTools = new Set(PLANNING_TOOLS)
    const providerOverride = { provider: run.provider, model: run.model ?? undefined }
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
        null
      )
      let plan = first.plan
      let turnsUsed = 1
      let tokensUsed = first.tokens
      let flaggedTurns = run.flaggedTurns + (first.fabricationDetected ? 1 : 0)

      // A real user Stop (or any internal stop other than the loop guard's
      // own, recoverable one) must end the run immediately, not fall through
      // to the retry below — retrying against a signal that's already
      // aborted produces no plan either, and previously reported "Could not
      // produce a plan for review" (status: error) for what was actually a
      // deliberate user action, not a failure. A loop-guard stop is exempt:
      // it already produces no plan, so the existing "no plan yet, retry
      // once" logic is the right response either way.
      if (first.stopped && first.stopReason !== 'loop-guard') {
        agentRunStore.update(run.id, { turnsUsed, tokensUsed, flaggedTurns })
        this.finish(run.id, conversation.id, 'stopped', null, 'Run was stopped.')
        return
      }

      if (!plan) {
        const retry = await this.runTurn(
          conversation,
          PLAN_RETRY_PROMPT,
          planningTools,
          providerOverride,
          controller.signal,
          null
        )
        turnsUsed = 2
        tokensUsed += retry.tokens
        if (retry.fabricationDetected) flaggedTurns += 1
        if (retry.stopped && retry.stopReason !== 'loop-guard') {
          agentRunStore.update(run.id, { turnsUsed, tokensUsed, flaggedTurns })
          this.finish(run.id, conversation.id, 'stopped', null, 'Run was stopped.')
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
      this.runningRunId = null
      this.activeController = null
    }

    // Deliberately outside the try/finally above: `approvePlan` re-acquires
    // the same `runningRunId`/`activeController` lock `runPlanningPhase` just
    // released in `finally`, so calling it any earlier — e.g. from inside the
    // try block, before that `finally` has run — would have `runLoop`
    // overwrite the lock and then have this method's own `finally` clobber it
    // right back to null out from under an execution loop that's actually
    // still running.
    if (autoApprove) this.approvePlan(run.id)
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
    currentPlan: Plan | null
  ): Promise<{
    finished: boolean
    summary: string | null
    stopped: boolean
    stopReason?: 'user' | 'loop-guard'
    tokens: number
    plan: Plan | null
    /** See `AgentRun.flaggedTurns`'s doc comment. */
    fabricationDetected: boolean
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
        // Same fail-closed-on-destructive stance as scheduled tasks — no one
        // is present to click an approval modal on a run's behalf.
        permissionModeOverride: 'untethered',
        onActivity: (call) => toolCallsById.set(call.id, call),
        confirm: (confirmRequest) =>
          Promise.resolve({ approved: confirmRequest.risk !== 'destructive' })
      }
    )

    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: result.content,
      createdAt: Date.now(),
      stats: result.stats,
      memoryUsed: result.memoryUsed,
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

    this.saveConversationTurn(conversation, [userMessage, assistantMessage])
    // `conversation` is reused by the next turn in this same loop — keep its
    // in-memory `messages` in sync with what was just persisted.
    conversation.messages = [...conversation.messages, userMessage, assistantMessage]

    return {
      finished: Boolean(finishCall),
      summary: finishCall?.detail ?? null,
      stopped: result.stopped,
      stopReason: result.stopReason,
      tokens: result.stats.tokens,
      plan: latestPlan,
      fabricationDetected: result.fabricationDetected ?? false
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

  private saveConversationTurn(conversation: Conversation, newMessages: ChatMessage[]): void {
    conversationStore.save({
      ...conversation,
      messages: [...conversation.messages, ...newMessages],
      archived: false,
      archivedAt: undefined,
      updatedAt: Date.now()
    })
  }

  private broadcastRunsChanged(): void {
    const runs = agentRunStore.list()
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      window.webContents.send(IpcChannel.Agent.runsChanged, runs)
    }
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
