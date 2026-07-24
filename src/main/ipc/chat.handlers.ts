import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { ok, err, toErrorMessage } from '@shared/result'
import type { ChatCompactRequest, ChatRequest, ChatTitleRequest } from '@shared/chat.types'
import { llamaService } from '../llama/LlamaService'
import { isDroppedStreamMessage } from '../llama/droppedStreamError'
import { requestToolConfirmation } from './tools.handlers'
import { runBoundedChatGeneration } from '../chat/boundedChatRunner'
import {
  abortAllGenerations,
  abortGeneration,
  registerGeneration,
  releaseGeneration
} from '../chat/inflightGenerations'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:chat')

const VISION_RUNTIME_STOPPED_MESSAGE =
  'The local vision model stopped unexpectedly (most likely it ran out of memory). Reload the ' +
  'model, lower its context size, or choose a smaller vision model, then try again.'

/** Abort every in-flight chat generation — called on app quit. */
export function abortAllChatGenerations(): void {
  abortAllGenerations()
}

/** IPC handlers for streaming chat generation and stopping it. */
export function registerChatHandlers(): void {
  ipcMain.handle(IpcChannel.Chat.send, async (event, request: ChatRequest) => {
    const controller = new AbortController()
    registerGeneration(request.conversationId, controller)

    try {
      const result = await runBoundedChatGeneration(request, {
        signal: controller.signal,
        onToken: (token) => {
          if (event.sender.isDestroyed()) return
          event.sender.send(IpcChannel.Chat.stream, {
            conversationId: request.conversationId,
            messageId: request.messageId,
            token
          })
        },
        onThinkingToken: (token) => {
          if (event.sender.isDestroyed()) return
          event.sender.send(IpcChannel.Chat.thinkingStream, {
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
          'The model input is too large for the current context window. Anodex already defers nonessential tool schemas automatically; shorten unusually large project/assistant instructions or use a larger supported context.',
          message
        )
      }
      // node-llama-cpp (via lifecycle-utils' DisposedError) throws this exact,
      // internal-sounding string when the model's session/context gets torn
      // down mid-generation — e.g. switching or unloading the model while a
      // reply is still streaming. Not something the user did wrong, and not
      // safely auto-retryable here, so surface it as a plain ask-to-retry
      // instead of the raw native error text.
      if (message === 'Object is disposed') {
        return err(
          'chat.generation-interrupted',
          'The model was reloaded or unloaded while generating a reply. Send your message again once it finishes loading.',
          message
        )
      }
      // A bare `terminated` (or socket "other side closed") means the local
      // vision runtime's llama-server process dropped the connection mid-reply,
      // most often an out-of-memory kill. The vision provider already rewrites
      // this with the runtime's real exit reason; this is a catch-all for any
      // other path so the user never sees the raw word.
      if (isDroppedStreamMessage(message)) {
        return err('chat.vision-runtime-stopped', VISION_RUNTIME_STOPPED_MESSAGE, message)
      }
      return err('chat.generation-failed', message)
    } finally {
      releaseGeneration(request.conversationId, controller)
    }
  })

  ipcMain.handle(IpcChannel.Chat.stop, (_event, conversationId: string) => {
    abortGeneration(conversationId)
  })

  ipcMain.handle(IpcChannel.Chat.compact, async (_event, request: ChatCompactRequest) => {
    try {
      return ok(await llamaService.compactConversationContext(request))
    } catch (error) {
      const message = toErrorMessage(error)
      log.error('Manual context compaction failed:', error)
      if (isDroppedStreamMessage(message)) {
        return err('chat.vision-runtime-stopped', VISION_RUNTIME_STOPPED_MESSAGE, message)
      }
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
