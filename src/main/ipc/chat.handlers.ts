import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { ok, err, toErrorMessage } from '@shared/result'
import type { ChatCompactRequest, ChatRequest, ChatTitleRequest } from '@shared/chat.types'
import { llamaService } from '../llama/LlamaService'
import { requestToolConfirmation } from './tools.handlers'
import { runGeneration } from '../chat/runGeneration'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:chat')

/** Abort controllers for in-flight generations, keyed by conversation. */
const inflight = new Map<string, AbortController>()

/** Abort every in-flight chat generation — called on app quit. */
export function abortAllChatGenerations(): void {
  for (const controller of inflight.values()) controller.abort()
  inflight.clear()
}

/** IPC handlers for streaming chat generation and stopping it. */
export function registerChatHandlers(): void {
  ipcMain.handle(IpcChannel.Chat.send, async (event, request: ChatRequest) => {
    const controller = new AbortController()
    // Abort any prior generation still registered for this conversation before
    // taking over the slot — otherwise an overlapping send would silently
    // orphan the earlier controller, leaving it unreachable by Stop.
    inflight.get(request.conversationId)?.abort()
    inflight.set(request.conversationId, controller)

    try {
      const result = await runGeneration(request, {
        signal: controller.signal,
        onToken: (token) => {
          if (event.sender.isDestroyed()) return
          event.sender.send(IpcChannel.Chat.stream, {
            conversationId: request.conversationId,
            messageId: request.messageId,
            token
          })
        },
        onActivity: (call) => {
          if (event.sender.isDestroyed()) return
          event.sender.send(IpcChannel.Tools.activity, {
            conversationId: request.conversationId,
            messageId: request.messageId,
            call
          })
        },
        confirm: (confirmRequest) =>
          requestToolConfirmation(event.sender, confirmRequest, controller.signal)
      })

      return ok({
        conversationId: request.conversationId,
        messageId: request.messageId,
        ...result
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
      // Only clear the slot if it's still ours — an overlapping send may have
      // already replaced it with its own controller, and that one is still
      // running.
      if (inflight.get(request.conversationId) === controller) {
        inflight.delete(request.conversationId)
      }
    }
  })

  ipcMain.handle(IpcChannel.Chat.stop, (_event, conversationId: string) => {
    inflight.get(conversationId)?.abort()
  })

  ipcMain.handle(IpcChannel.Chat.compact, async (_event, request: ChatCompactRequest) => {
    try {
      return ok(await llamaService.compactConversationContext(request))
    } catch (error) {
      const message = toErrorMessage(error)
      log.error('Manual context compaction failed:', error)
      return err('chat.compaction-failed', message)
    }
  })

  // Deliberately calls `llamaService` directly rather than `getActiveProvider()` —
  // a desktop toast's title should always come from the local model (fast, free,
  // no extra network round-trip for a side notification), regardless of which
  // provider a future cloud-provider setting might have made "active" for real replies.
  ipcMain.handle(IpcChannel.Chat.summarize, (_event, text: string, maxWords: number) =>
    llamaService.summarizeForToast(text, maxWords)
  )

  ipcMain.handle(IpcChannel.Chat.title, (_event, request: ChatTitleRequest) =>
    llamaService.generateChatTitle(request)
  )
}
