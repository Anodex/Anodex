import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { ok, err, toErrorMessage } from '@shared/result'
import type { ChatRequest } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import { composeSystemPrompt } from '@shared/prompts'
import { getActiveProvider } from '../llm/ProviderRegistry'
import { llamaService } from '../llama/LlamaService'
import { settingsStore } from '../settings/SettingsStore'
import { projectStore } from '../projects/ProjectStore'
import { projectMemoryStore } from '../projects/ProjectMemoryStore'
import { tokenActivityStore } from '../stats/TokenActivityStore'
import { buildWorkspaceContext } from '../tools/workspaceContext'
import { requestToolConfirmation } from './tools.handlers'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:chat')

/** Abort controllers for in-flight generations, keyed by conversation. */
const inflight = new Map<string, AbortController>()

/** IPC handlers for streaming chat generation and stopping it. */
export function registerChatHandlers(): void {
  ipcMain.handle(IpcChannel.Chat.send, async (event, request: ChatRequest) => {
    const controller = new AbortController()
    inflight.set(request.conversationId, controller)

    // Enable tools whenever the feature is on. Workspace (file/command) tools
    // require an open project; web tools work regardless. `workspaceRoot` is
    // forced to null without one — belt-and-suspenders on top of there being no
    // UI path to set `settings.workspace.root` outside a project anymore, so a
    // stray/legacy value there can never leak file access into a plain chat.
    const settings = settingsStore.get()
    const projects = projectStore.getState()
    const workspaceRoot = projects.activeProjectId ? settings.workspace.root : null
    let hadToolActivity = false
    const toolNamesThisTurn: string[] = []
    const tools = settings.tools.enabled
      ? {
          workspaceRoot,
          permissionMode: settings.general.permissionMode,
          projectId: projects.activeProjectId,
          webSearch: settings.webSearch,
          plan: request.plan ?? null,
          onActivity: (call: ToolCall) => {
            hadToolActivity = true
            // `onActivity` fires once per status transition for the same call
            // id ('running', then a terminal status) — only tally on the
            // terminal, actually-executed ones, matching the same guard
            // `LlamaService.generate()` already uses before recording to
            // `modelReliabilityStore`.
            if (call.status === 'success' || call.status === 'error') {
              toolNamesThisTurn.push(call.name)
            }
            if (event.sender.isDestroyed()) return
            event.sender.send(IpcChannel.Tools.activity, {
              conversationId: request.conversationId,
              messageId: request.messageId,
              call
            })
          },
          confirm: (confirmRequest: Parameters<typeof requestToolConfirmation>[1]) =>
            requestToolConfirmation(event.sender, confirmRequest, controller.signal)
        }
      : undefined

    // Compose the full system prompt: built-in coding-agent discipline, an
    // auto-generated summary of the active workspace (including recent activity
    // remembered from past conversations in this project), the active project's
    // own rules, and the user's free-form guidance.
    const hasWorkspaceTools = settings.tools.enabled && Boolean(workspaceRoot)
    const activeProject = projects.projects.find((p) => p.id === projects.activeProjectId)
    const systemPrompt = composeSystemPrompt({
      hasWorkspaceTools,
      hasProject: Boolean(projects.activeProjectId),
      workspaceContext:
        hasWorkspaceTools && workspaceRoot
          ? buildWorkspaceContext(workspaceRoot, projects.activeProjectId)
          : null,
      projectRules: activeProject?.instructions ?? null,
      userInstructions: settings.ui.systemPrompt
    })

    try {
      const outcome = await getActiveProvider().generate({
        conversationId: request.conversationId,
        messageId: request.messageId,
        systemPrompt,
        history: request.history,
        prompt: request.prompt,
        options: request.options,
        signal: controller.signal,
        tools,
        onToken: (token) => {
          if (event.sender.isDestroyed()) return
          event.sender.send(IpcChannel.Chat.stream, {
            conversationId: request.conversationId,
            messageId: request.messageId,
            token
          })
        }
      })

      // Remember this turn in project memory so a future conversation in the
      // same project has ambient context, not just this one's chat history.
      if (hadToolActivity && !outcome.stopped && projects.activeProjectId && outcome.content) {
        projectMemoryStore.recordSummary(
          projects.activeProjectId,
          request.conversationId,
          outcome.content
        )
      }

      // Recorded regardless of `stopped` — real tokens were generated either way.
      const modelState = llamaService.getState()
      if (outcome.stats.tokens > 0 && modelState.model) {
        tokenActivityStore.recordGeneration({
          tokens: outcome.stats.tokens,
          inputTokens: llamaService.countPromptTokens(request.prompt),
          durationMs: outcome.stats.durationMs,
          toolNames: toolNamesThisTurn,
          conversationId: request.conversationId,
          modelId: modelState.model.id,
          modelName: modelState.model.name
        })
      }

      return ok({
        conversationId: request.conversationId,
        messageId: request.messageId,
        content: outcome.content,
        stats: outcome.stats,
        stopped: outcome.stopped
      })
    } catch (error) {
      const message = toErrorMessage(error)
      log.error('Generation failed:', error)
      if (
        message.includes('compress chat history') ||
        message.includes('too long prompt') ||
        message.includes('too long system message')
      ) {
        return err(
          'chat.context-too-small',
          'The prompt is too long for the current context size. Try increasing the context size in Settings → AI & Models, disabling workspace tools, or shortening project instructions.',
          message
        )
      }
      return err('chat.generation-failed', message)
    } finally {
      inflight.delete(request.conversationId)
    }
  })

  ipcMain.handle(IpcChannel.Chat.stop, (_event, conversationId: string) => {
    inflight.get(conversationId)?.abort()
  })

  // Deliberately calls `llamaService` directly rather than `getActiveProvider()` —
  // a desktop toast's title should always come from the local model (fast, free,
  // no extra network round-trip for a side notification), regardless of which
  // provider a future cloud-provider setting might have made "active" for real replies.
  ipcMain.handle(IpcChannel.Chat.summarize, (_event, text: string, maxWords: number) =>
    llamaService.summarizeForToast(text, maxWords)
  )
}
