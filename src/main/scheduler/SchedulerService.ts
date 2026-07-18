import { BrowserWindow } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { ChatMessage } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'
import type { ScheduledTask } from '@shared/scheduledTask.types'
import type { ToolCall } from '@shared/tools.types'
import { messageToHistoryTurn } from '@shared/chatSanitizer'
import { conversationStore } from '../conversations/ConversationStore'
import { llamaService } from '../llama/LlamaService'
import { showToastWindow } from '../toastWindow'
import { runGeneration } from '../chat/runGeneration'
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
 * on first run, reused after), reusing `runGeneration()` — the same headless
 * entry point `chat.handlers.ts` wraps for interactive chat — restricted to
 * only the tools the task owner explicitly opted in, with a headless
 * `confirm` that never blocks on a user who isn't there (see `runGeneration`'s
 * `enabledTools`/`permissionModeOverride`).
 */
class SchedulerService {
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private runningTaskId: string | null = null
  private activeController: AbortController | null = null

  init(): void {
    this.startupTimer = setTimeout(() => void this.tick(), STARTUP_TICK_DELAY_MS)
    this.tickTimer = setInterval(() => void this.tick(), TICK_INTERVAL_MS)
    log.info('Scheduler service started')
  }

  /** Stop the loop and abort any run in progress — called on app quit. */
  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.tickTimer = null
    this.startupTimer = null
    this.activeController?.abort()
  }

  /** Manually trigger a task right now, regardless of its schedule. */
  async runNow(taskId: string): Promise<void> {
    const task = schedulerStore.get(taskId)
    if (!task) throw new Error(`Scheduled task not found: ${taskId}`)
    if (this.runningTaskId) throw new Error('Another scheduled task is currently running.')
    await this.runTask(task)
  }

  private async tick(): Promise<void> {
    if (this.runningTaskId) return
    const now = Date.now()
    const due = schedulerStore
      .list()
      .find((task) => task.enabled && task.nextRunAt !== null && task.nextRunAt <= now)
    if (!due) return
    await this.runTask(due)
  }

  private async runTask(task: ScheduledTask): Promise<void> {
    this.runningTaskId = task.id
    const controller = new AbortController()
    this.activeController = controller
    log.info('Running scheduled task:', task.id, task.name)

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

    try {
      const result = await runGeneration(
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
          signal: controller.signal,
          enabledTools: new Set(task.enabledTools),
          // Restricted to only the tools the task owner opted in (above); of
          // those, everything except a destructive-risk call auto-runs, since
          // there's no one present to click an approval modal. Destructive
          // calls still fail safe instead of hanging the run indefinitely.
          permissionModeOverride: 'untethered',
          onActivity: (call) => toolCallsById.set(call.id, call),
          confirm: (request) => Promise.resolve({ approved: request.risk !== 'destructive' })
        }
      )

      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        role: 'assistant',
        content: result.content,
        createdAt: Date.now(),
        stats: result.stats,
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
      this.saveConversationTurn(conversation, [userMessage, assistantMessage])

      const summary = await this.summarize(result.content)
      schedulerStore.recordRun(task.id, {
        status: result.stopped ? 'stopped' : 'success',
        summary,
        conversationId: conversation.id,
        messageId: assistantMessageId,
        fabricationDetected: result.fabricationDetected ?? false
      })
      showToastWindow({
        title: task.name,
        body: summary ?? 'Finished — open the chat to see the reply.',
        conversationId: conversation.id
      })
    } catch (error) {
      log.error('Scheduled task run failed:', task.id, error)
      // Still append the user turn so the conversation shows what was
      // attempted, even though it failed.
      this.saveConversationTurn(conversation, [userMessage])
      schedulerStore.recordRun(task.id, {
        status: 'error',
        summary: error instanceof Error ? error.message : 'Run failed.',
        conversationId: conversation.id,
        messageId: null
      })
      showToastWindow({
        title: task.name,
        body: 'This scheduled task failed to run.',
        conversationId: conversation.id
      })
    } finally {
      this.runningTaskId = null
      this.activeController = null
      this.broadcastTasksChanged()
    }
  }

  private getOrCreateConversation(task: ScheduledTask): Conversation {
    const existing = task.conversationId
      ? conversationStore.listAll().find((c) => c.id === task.conversationId)
      : undefined
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

  /** Persist new messages onto a task's conversation, un-archiving it if the user had archived it. */
  private saveConversationTurn(conversation: Conversation, newMessages: ChatMessage[]): void {
    conversationStore.save({
      ...conversation,
      messages: [...conversation.messages, ...newMessages],
      archived: false,
      archivedAt: undefined,
      updatedAt: Date.now()
    })
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

  private broadcastTasksChanged(): void {
    const tasks = schedulerStore.list()
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      window.webContents.send(IpcChannel.Scheduler.tasksChanged, tasks)
    }
  }
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export const schedulerService = new SchedulerService()
