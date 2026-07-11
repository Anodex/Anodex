import { BrowserWindow } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { ChatMessage } from '@shared/chat.types'
import type { Conversation } from '@shared/conversation.types'
import type { AgentRun, CreateAgentRunRequest } from '@shared/agentRun.types'
import type { ToolCall } from '@shared/tools.types'
import { messageToHistoryTurn } from '@shared/chatSanitizer'
import { conversationStore } from '../conversations/ConversationStore'
import { showToastWindow } from '../toastWindow'
import { runGeneration } from '../chat/runGeneration'
import { createLogger } from '../utils/logger'
import { agentRunStore } from './AgentRunStore'
import { buildKickoffPrompt, CONTINUE_PROMPT } from './agentPrompts'

const log = createLogger('agent-run-service')

/**
 * Tools every agent run gets regardless of what the user picked when
 * creating it — skill discovery and the run's own termination signal.
 */
const ALWAYS_ON_TOOLS = ['find_skill', 'load_skill', 'finish_goal']

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

  /** Create the run + its conversation, then start its turn loop in the background. */
  start(request: CreateAgentRunRequest): AgentRun {
    if (this.runningRunId) throw new Error('Another agent run is currently in progress.')
    const run = agentRunStore.create(request)
    const conversation = this.createConversation(run)
    agentRunStore.update(run.id, { conversationId: conversation.id })
    void this.runLoop({ ...run, conversationId: conversation.id }, conversation)
    return agentRunStore.get(run.id)!
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

  private async runLoop(run: AgentRun, conversation: Conversation): Promise<void> {
    this.runningRunId = run.id
    const controller = new AbortController()
    this.activeController = controller
    log.info('Starting agent run:', run.id, run.goal)

    const enabledTools = new Set([...run.enabledTools, ...ALWAYS_ON_TOOLS])
    // Never touches the user's global `provider.active` setting — see
    // `RunGenerationIo.providerOverride`.
    const providerOverride = { provider: run.provider, model: run.model ?? undefined }
    let turnsUsed = 0

    try {
      for (let turn = 1; turn <= run.maxTurns; turn++) {
        turnsUsed = turn
        const prompt = turn === 1 ? buildKickoffPrompt(run.goal) : CONTINUE_PROMPT
        const { finished, summary, stopped } = await this.runTurn(
          conversation,
          prompt,
          enabledTools,
          providerOverride,
          controller.signal
        )
        agentRunStore.update(run.id, { turnsUsed })
        this.broadcastRunsChanged()

        if (stopped) {
          this.finish(run.id, conversation.id, 'stopped', null, 'Run was stopped.')
          return
        }
        if (finished) {
          this.finish(run.id, conversation.id, 'done', summary, null)
          return
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

  /** Run one turn, appending it to the conversation, and report whether `finish_goal` fired. */
  private async runTurn(
    conversation: Conversation,
    prompt: string,
    enabledTools: Set<string>,
    providerOverride: { provider: AgentRun['provider']; model?: string },
    signal: AbortSignal
  ): Promise<{ finished: boolean; summary: string | null; stopped: boolean }> {
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
        plan: null
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
    this.saveConversationTurn(conversation, [userMessage, assistantMessage])
    // `conversation` is reused by the next turn in this same loop — keep its
    // in-memory `messages` in sync with what was just persisted.
    conversation.messages = [...conversation.messages, userMessage, assistantMessage]

    const finishCall = [...toolCallsById.values()].find(
      (call) => call.name === 'finish_goal' && call.status === 'success'
    )
    return {
      finished: Boolean(finishCall),
      summary: finishCall?.detail ?? null,
      stopped: result.stopped
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

export const agentRunService = new AgentRunService()
