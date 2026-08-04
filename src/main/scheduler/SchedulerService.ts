import { IpcChannel } from '@shared/ipc'
import { broadcastToWindows } from '../broadcast'
import type { ChatMessage, GenerationStopReason } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'
import type { ScheduledTask } from '@shared/scheduledTask.types'
import type { ToolCall } from '@shared/tools.types'
import { messageToHistoryTurn } from '@shared/chatSanitizer'
import { conversationStore } from '../conversations/ConversationStore'
import { appendBackgroundTurn } from '../conversations/backgroundTurn'
import { llamaService } from '../llama/LlamaService'
import { showToastWindow } from '../toastWindow'
import { runBoundedChatGeneration } from '../chat/boundedChatRunner'
import { SCHEDULED_TASK_BUDGET } from '../chat/GenerationBudget'
import { headlessConfirm } from '../tools/headlessConfirm'
import { createLogger } from '../utils/logger'
import { schedulerStore } from './SchedulerStore'

const log = createLogger('scheduler-service')

const TICK_INTERVAL_MS = 30_000
/** Give the app a moment to finish hydrating before the first due-task check, same reasoning as the model auto-load delay. */
const STARTUP_TICK_DELAY_MS = 5000
const SUMMARY_MAX_WORDS = 18

/**
 * Runs scheduled tasks in the background while the app is open. A single
 * `setInterval` checks for due tasks; only one task runs at a time (a simple
 * lock, not a queue) so a background run never contends with another
 * scheduled run or a foreground chat generation on the local engine.
 *
 * Each run appends to the task's own persisted `Conversation` (created lazily
 * on first run, reused after), reusing `runBoundedChatGeneration()` — the same
 * bounded, auto-continuing entry point `chat.handlers.ts` wraps for
 * interactive chat (see `boundedChatRunner.ts`) — restricted to only the
 * tools the task owner explicitly opted in, with a headless `confirm` that
 * never blocks on a user who isn't there (see `runGeneration`'s
 * `enabledTools`/`permissionModeOverride`).
 */
class SchedulerService {
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private runningTaskId: string | null = null
  private activeController: AbortController | null = null
  /** Set once `stop()` has run, so a run still unwinding doesn't act as if the app were still up. */
  private stopping = false

  init(): void {
    // A scheduler that has been started is not shutting down. Without this a
    // restart would leave `stopping` latched from the previous `stop()` and
    // silently suppress every run's toast from then on.
    this.stopping = false
    this.startupTimer = setTimeout(() => this.safeTick(), STARTUP_TICK_DELAY_MS)
    this.tickTimer = setInterval(() => this.safeTick(), TICK_INTERVAL_MS)
    log.info('Scheduler service started')
  }

  /** Stop the loop and abort any run in progress — called on app quit. */
  stop(): void {
    this.stopping = true
    if (this.tickTimer) clearInterval(this.tickTimer)
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.tickTimer = null
    this.startupTimer = null
    this.activeController?.abort()
  }

  /**
   * `tick` is driven by timers, which have nowhere to report a rejection to.
   * `runTask` is written not to reject, but a bug that made it do so would
   * otherwise surface only as an unhandled rejection with no context.
   */
  private safeTick(): void {
    this.tick().catch((error) => log.error('Scheduler tick failed:', error))
  }

  /** Manually trigger a task right now, regardless of its schedule. */
  async runNow(taskId: string): Promise<void> {
    const task = schedulerStore.get(taskId)
    if (!task) throw new Error(`Scheduled task not found: ${taskId}`)
    if (this.runningTaskId) throw new Error('Another scheduled task is currently running.')
    await this.runTask(task)
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    const due = schedulerStore
      .list()
      .filter((task) => task.enabled && task.nextRunAt !== null && task.nextRunAt <= now)
    if (due.length === 0) return

    // Never contend with a foreground reply. A due task waits (its `nextRunAt`
    // is left untouched, so the next tick retries) rather than colliding with
    // the user's own generation on the single local engine — otherwise the
    // model lock would just queue this background run right behind their chat,
    // and before that guard existed it failed outright with "A response is
    // already being generated".
    if (llamaService.isGenerating()) {
      log.info(
        `${due.length} task(s) due while a foreground reply is generating — deferring to a later tick`
      )
      return
    }

    // Only one task runs at a time. The rest aren't dropped — their `nextRunAt`
    // is left alone, so the next tick picks them up as soon as the lock frees —
    // but the wait is recorded as `delayedMs` on whichever run eventually
    // happens, so a task that habitually runs late is visible instead of just
    // feeling slow.
    if (this.runningTaskId) {
      log.info(
        `${due.length} task(s) due while "${this.runningTaskId}" is running — they will start once it finishes`
      )
      return
    }

    // Oldest due slot first, so a task that has been waiting doesn't keep
    // losing to one that just came due.
    const next = due.sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0]
    await this.runTask(next)
  }

  /**
   * Hold the run lock for one task, and release it whatever happens.
   *
   * Everything that can fail lives inside the `try`, including creating the
   * task's conversation. That write can throw on its own — `ConversationStore`
   * rethrows a failed save rather than swallowing it — and it used to sit
   * between taking the lock and the `try`, so a full disk or a locked file
   * escaped past the `finally` with `runningTaskId` still set. From then on
   * every tick found "a task is already running", `runNow` refused for the
   * same reason, and no `recordRun` ever advanced `nextRunAt`: one failed
   * write stopped every scheduled task for the life of the process.
   */
  private async runTask(task: ScheduledTask): Promise<void> {
    this.runningTaskId = task.id
    const controller = new AbortController()
    this.activeController = controller
    const startedAt = Date.now()
    log.info('Running scheduled task:', task.id, task.name)

    try {
      await this.executeRun(task, controller.signal, startedAt)
    } catch (error) {
      // `executeRun` reports a failed *generation* itself, so anything landing
      // here failed before the run had a conversation to record against. It is
      // still recorded, so the schedule advances rather than leaving the task
      // permanently due and re-attempted every 30 seconds.
      log.error('Scheduled task could not start:', task.id, error)
      schedulerStore.recordRun(task.id, {
        status: 'error',
        summary: error instanceof Error ? error.message : 'Run failed.',
        conversationId: task.conversationId,
        messageId: null,
        userMessageId: null,
        startedAt
      })
    } finally {
      this.runningTaskId = null
      this.activeController = null
      this.notifyTasksChanged()
    }
  }

  /** One run, start to finish: generate, persist the turn, record the outcome, announce it. */
  private async executeRun(
    task: ScheduledTask,
    signal: AbortSignal,
    startedAt: number
  ): Promise<void> {
    const conversation = this.getOrCreateConversation(task)
    const userMessage: ChatMessage = {
      id: generateId('sched_msg'),
      role: 'user',
      content: task.prompt,
      createdAt: Date.now()
    }
    const assistantMessageId = generateId('sched_msg')
    // Keyed by call id so each call's *latest* status (running → terminal)
    // overwrites the earlier one, while insertion order still reflects the
    // order calls started — same de-dup shape the interactive chat path gets
    // for free from the renderer's own tool-activity accumulation.
    const toolCallsById = new Map<string, ToolCall>()
    /** Guards the failure path from re-appending a prompt whose turn was already persisted. */
    let turnSaved = false
    let toastBody: string

    try {
      const result = await runBoundedChatGeneration(
        {
          conversationId: conversation.id,
          messageId: assistantMessageId,
          projectId: task.projectId,
          context: conversation.context ?? null,
          history: conversation.messages.map(messageToHistoryTurn),
          prompt: task.prompt,
          plan: null
        },
        {
          signal,
          enabledTools: new Set(task.enabledTools),
          // Restricted to only the tools the task owner opted in (above); of
          // those, `headlessConfirm` decides what may run with no one present
          // to click an approval modal. It refuses rather than hangs, so a
          // blocked call fails the step instead of stranding the run.
          permissionModeOverride: 'untethered',
          executionBudget: SCHEDULED_TASK_BUDGET,
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
        memoryUsed: result.memoryUsed,
        thinking: result.thinking,
        toolCalls: toolCallsById.size > 0 ? [...toolCallsById.values()] : undefined
      }
      // A new compacted context snapshot this turn (cloud providers only —
      // see `RunGenerationResult.context`'s doc comment). Without persisting
      // this, the task's next scheduled run would re-summarize the same
      // growing history from scratch instead of seeding from what this run
      // already paid to compact.
      if (result.context) conversation.context = result.context
      appendBackgroundTurn(conversation, [userMessage, assistantMessage])
      turnSaved = true

      const summary = result.stopped
        ? scheduledStopSummary(result.stopReason, result.stopDetail)
        : await this.summarize(result.content)
      schedulerStore.recordRun(task.id, {
        status: result.stopped ? 'stopped' : 'success',
        summary,
        conversationId: conversation.id,
        messageId: assistantMessageId,
        userMessageId: userMessage.id,
        startedAt,
        fabricationDetected: result.fabricationDetected ?? false
      })
      toastBody = summary ?? 'Finished — open the chat to see the reply.'
    } catch (error) {
      log.error('Scheduled task run failed:', task.id, error)
      // Still append the user turn so the conversation shows what was
      // attempted — unless the reply was already persisted, in which case the
      // failure came from reporting the run rather than from running it, and
      // appending again would stack a second copy of the prompt on top of a
      // turn that succeeded.
      if (!turnSaved) appendBackgroundTurn(conversation, [userMessage])
      schedulerStore.recordRun(task.id, {
        status: 'error',
        summary: error instanceof Error ? error.message : 'Run failed.',
        conversationId: conversation.id,
        messageId: null,
        userMessageId: userMessage.id,
        startedAt
      })
      toastBody = 'This scheduled task failed to run.'
    }

    // Announcing the run is deliberately outside the block above. Opening a
    // window is the one step here that can fail for reasons of its own, and
    // when it did, the failure path re-entered as though the *run* had failed:
    // it recorded a second run, reported the successful one as an error, and
    // re-saved the conversation without the reply it had just written.
    this.announceRun(task, toastBody, conversation.id)
  }

  /**
   * Show the run's toast, unless the app is on its way out. `stop()` aborts the
   * in-flight run, which unwinds a tick later — by then `will-quit` has already
   * run `closeToast()`, so a toast opened here would be a window created during
   * shutdown that nothing is left to close.
   */
  private announceRun(task: ScheduledTask, body: string, conversationId: string): void {
    if (this.stopping) {
      log.info('Skipping toast for', task.id, '— the app is quitting')
      return
    }
    try {
      showToastWindow({ title: task.name, body, conversationId })
    } catch (error) {
      // The run is finished and already recorded by this point. Failing to
      // announce it is not a failure of the run, and must not reach a handler
      // that would record it a second time as one.
      log.warn('Failed to show the toast for scheduled task', task.id, error)
    }
  }

  private getOrCreateConversation(task: ScheduledTask): Conversation {
    const existing = task.conversationId ? conversationStore.get(task.conversationId) : undefined
    if (existing) return existing

    const conversation: Conversation = {
      id: generateId('sched_conv'),
      projectId: task.projectId,
      title: task.name,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      origin: 'scheduled'
    }
    conversationStore.save(conversation)
    return conversation
  }

  /** Best-effort local summary for the toast body; falls back to null if the local model isn't ready. */
  private async summarize(content: string): Promise<string | null> {
    if (!content.trim()) return null
    try {
      return await llamaService.summarizeForToast(content, SUMMARY_MAX_WORDS)
    } catch (error) {
      log.warn('Failed to summarize scheduled task result:', error)
      return null
    }
  }

  /**
   * Push the current task list to every window. Public because the
   * `schedule_task` tool writes through `schedulerStore` directly rather than
   * over IPC, so nothing else would tell the Scheduler page a task appeared.
   */
  notifyTasksChanged(): void {
    broadcastToWindows(IpcChannel.Scheduler.tasksChanged, schedulerStore.list())
  }
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function scheduledStopSummary(
  stopReason: GenerationStopReason | undefined,
  stopDetail?: string
): string {
  switch (stopReason) {
    case 'fixed-context-limit':
      return 'Could not start: fixed instructions and tools do not fit the model context.'
    case 'context-limit':
      return 'Stopped early after reaching the model context limit.'
    case 'context-shift-limit':
      return 'Stopped early after reaching the context-compaction limit.'
    case 'rounds-exhausted':
      return 'Stopped early after reaching the provider-round limit.'
    case 'tool-limit':
      return 'Stopped early after reaching the tool-call limit.'
    case 'token-limit':
      return 'Stopped early after reaching the safe local output-token limit.'
    case 'time-limit':
      return 'Stopped early after reaching the scheduled-run time limit.'
    case 'loop-guard':
    case 'no-progress':
      return 'Stopped early after repeating work without progress.'
    // Nobody is watching an unattended run, so the two reasons that name a
    // real fault must say so here. Falling through to the generic default
    // reported a provider outage and a clean finish in the same words.
    case 'provider-error':
      return stopDetail
        ? `Stopped early: the model provider failed. ${stopDetail}`
        : 'Stopped early: the model provider failed.'
    case 'runtime-stalled':
      return 'Stopped early: the local runtime stopped running the model. Reload the model.'
    case 'user':
      return 'The scheduled run was stopped by the user.'
    default:
      return 'The scheduled run stopped before completion.'
  }
}

export const schedulerService = new SchedulerService()
