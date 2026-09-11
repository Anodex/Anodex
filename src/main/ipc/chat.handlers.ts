import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { ok, err, toErrorMessage } from '@shared/result'
import type {
  ChatCompactRequest,
  ChatReplaySuggestionRequest,
  ChatRequest,
  ChatTitleRequest
} from '@shared/chat.types'
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
import { computerControlService } from '../computerControl/ComputerControlService'
import { isRemoteCall, resolveClientChannel } from '../clients/clientRegistry'
import { rehydrateUploadedImage } from '../remote/uploadStore'
import { projectConversationContext } from '@shared/contextProjection'
import { conversationStore } from '../conversations/ConversationStore'
import { settingsStore } from '../settings/SettingsStore'

const log = createLogger('ipc:chat')

const VISION_RUNTIME_STOPPED_MESSAGE =
  'The local vision model stopped unexpectedly (most likely it ran out of memory). Reload the ' +
  'model, lower its context size, or choose a smaller vision model, then try again.'

/** Abort every in-flight chat generation — called on app quit. */
export function abortAllChatGenerations(): void {
  abortAllGenerations()
  computerControlService.stopAll('generation-stopped')
}

/** IPC handlers for streaming chat generation and stopping it. */
export function registerChatHandlers(): void {
  ipcMain.handle(IpcChannel.Chat.send, async (event, rawRequest: ChatRequest) => {
    // A phone refers to an image it uploaded by the path it landed on, rather than
    // sending the bytes a second time as base64 in this request. Filled in here so
    // the runner downstream sees an ordinary turn and knows nothing about where the
    // picture came from.
    const request = isRemoteCall(event) ? await withUploadedImages(rawRequest) : rawRequest

    const controller = new AbortController()
    registerGeneration(request.conversationId, controller)

    // Resolved once per generation rather than reaching for `event.sender` at every
    // callback. The stream belongs to whoever started the turn, and that is no longer
    // necessarily a window: a remote call carries its client on the event instead,
    // and has no `sender` at all.
    const client = resolveClientChannel(event)

    try {
      const result = await runBoundedChatGeneration(request, {
        // This is the chat surface. It selects the conversational core prompt
        // rather than the coding-agent one — but only while no Project is open,
        // because opening a Project is what turns this window into the
        // workspace. See `composeSystemPrompt`.
        surface: 'chat',
        signal: controller.signal,
        onToken: (token) => {
          client.send(IpcChannel.Chat.stream, {
            conversationId: request.conversationId,
            messageId: request.messageId,
            token
          })
        },
        onThinkingToken: (token) => {
          client.send(IpcChannel.Chat.thinkingStream, {
            conversationId: request.conversationId,
            messageId: request.messageId,
            token
          })
        },
        onActivity: (call) => {
          client.send(IpcChannel.Tools.activity, {
            conversationId: request.conversationId,
            messageId: request.messageId,
            call
          })
        },
        confirm: (confirmRequest) =>
          requestToolConfirmation(client, confirmRequest, controller.signal)
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

  /**
   * How full one conversation's context is, for a client that cannot work it out.
   *
   * The desktop's own meter derives this in the renderer from three stores it
   * already holds. A phone holds none of them — not the settings, not the system
   * prompt the turn will carry, not the tool schemas — so without this it had
   * nothing to draw and drew nothing.
   *
   * It had been reading `contextTokensUsed` off the engine state instead, which is
   * a different number: the live KV-cache index, present only while a generation
   * is in flight in that session and `undefined` the rest of the time. The meter
   * on the machine has never used it.
   *
   * Named rather than active, because the phone is often looking at a different
   * conversation than the desk is.
   */
  ipcMain.handle(IpcChannel.Chat.contextUsage, (_event, conversationId: string) => {
    try {
      return ok(
        projectConversationContext({
          conversation: conversationStore.get(conversationId),
          settings: settingsStore.get(),
          engineContextSize: llamaService.getState().contextSize
        })
      )
    } catch (error) {
      return err(
        'chat.context-usage-failed',
        'Could not measure the context for that conversation.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.Chat.stop, (_event, conversationId: string) => {
    abortGeneration(conversationId)
    computerControlService.stopConversation(conversationId, 'generation-stopped')
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

  ipcMain.handle(IpcChannel.Chat.replaySuggestion, (_event, request: ChatReplaySuggestionRequest) =>
    llamaService.generateReplaySuggestion(request)
  )
}

/**
 * Turn a remote turn's uploaded image paths into image inputs.
 *
 * Only files the phone actually uploaded, and only ones that still look like the
 * image they claim to be — `rehydrateUploadedImage` refuses anything outside the
 * upload directory, so a path in a request is a request rather than a fact.
 *
 * Anything that does not resolve is dropped rather than failing the turn. A picture
 * that cannot be read is a worse reason to lose the question attached to it.
 */
async function withUploadedImages(request: ChatRequest): Promise<ChatRequest> {
  const files = request.userFiles ?? []
  if (files.length === 0 || (request.images?.length ?? 0) > 0) return request

  const rehydrated = await Promise.all(files.map((file) => rehydrateUploadedImage(file.path)))
  const images = rehydrated.filter((image) => image !== null)

  return images.length > 0 ? { ...request, images } : request
}
