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

    try {
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
          tokens,
          plan: nextPlan
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
        agentRunStore.update(run.id, { turnsUsed, tokensUsed, plan })
        this.broadcastRunsChanged()

        if (stopped) {
          this.finish(run.id, conversation.id, 'stopped', null, 'Run was stopped.')
          return
        }
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
   * `PLANNING_TOOLS`, then pauses in `needs-review` for a human to approve or
   * reject via `approvePlan`/`rejectPlan` — never falls through into the
   * normal turn loop itself.
   */
  private async runPlanningPhase(run: AgentRun, conversation: Conversation): Promise<void> {
    this.runningRunId = run.id
    const controller = new AbortController()
    this.activeController = controller
    log.info('Starting plan review phase for agent run:', run.id, run.goal)

    const planningTools = new Set(PLANNING_TOOLS)
    const providerOverride = { provider: run.provider, model: run.model ?? undefined }

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
        plan = retry.plan
      }

      agentRunStore.update(run.id, { turnsUsed, tokensUsed })

      if (!plan) {
        this.finish(run.id, conversation.id, 'error', null, 'Could not produce a plan for review.')
        return
      }

      agentRunStore.update(run.id, { status: 'needs-review', plan })
      this.broadcastRunsChanged()
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
    tokens: number
    plan: Plan | null
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
      tokens: result.stats.tokens,
      plan: latestPlan
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
