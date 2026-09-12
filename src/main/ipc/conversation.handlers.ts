import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { broadcastToOtherClients } from '../broadcast'
import { isRemoteCall, resolveClientChannel } from '../clients/clientRegistry'
import type {
  Conversation,
  ConversationState,
  ConversationSummary
} from '@shared/conversation.types'
import { err, ok, toErrorMessage } from '@shared/result'
import { conversationStore } from '../conversations/ConversationStore'
import { forRemote } from '../conversations/remoteTranscript'
import { conversationAssetStore } from '../conversations/ConversationAssetStore'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:conversations')

/** IPC handlers for conversation persistence. */
export function registerConversationHandlers(): void {
  ipcMain.handle(IpcChannel.Conversations.list, () => conversationStore.list())

  ipcMain.handle(IpcChannel.Conversations.listSummaries, () =>
    conversationStore.list().map(toSummary)
  )

  ipcMain.handle(IpcChannel.Conversations.get, (event, conversationId: string, limit?: number) => {
    const conversation = conversationStore.get(conversationId)
    if (!conversation) return null

    // The tail, because that is what a reader wants and what a model was last
    // talking about. Sending the head of a thousand-turn conversation is both
    // larger and less useful.
    const tail =
      limit == null || conversation.messages.length <= limit
        ? conversation
        : { ...conversation, messages: conversation.messages.slice(-limit) }

    // A count is not a size. Two hundred turns of an agent transcript carry tool
    // calls, render blocks and context assemblies the phone never reads, and one
    // reply asked to write a web page carries the page — which is how a 6MB frame
    // came to be refused outright by `MAX_RESPONSE_BYTES`, leaving conversations
    // that simply would not open from away. `forRemote` sends the four fields the
    // phone does read, and as many turns of them as will fit.
    return isRemoteCall(event) ? forRemote(tail) : tail
  })

  ipcMain.handle(IpcChannel.Conversations.listArchived, () => conversationStore.listArchived())

  ipcMain.handle(IpcChannel.Conversations.save, (event, conversation: Conversation) => {
    try {
      // A remote client may only be holding the tail of this conversation, so its
      // turns are merged rather than written over what is on disk. See
      // `ConversationStore.save`.
      conversationStore.save(conversation, { fromRemote: isRemoteCall(event) })

      // Every save is announced, to every client except the one that wrote it.
      //
      // This used to fire only for remote saves, so that a renderer would not be
      // told about its own edit mid-keystroke. That solved the echo and created a
      // worse hole: a conversation the *computer* wrote was announced to nobody, so
      // a paired phone watching a chat the desktop was working on never heard that
      // it had changed. It sat on the last turn it happened to have loaded.
      //
      // Excluding the author gets both: no client is told what it already knows,
      // and every other client — window or phone — finds out.
      broadcastToOtherClients(
        resolveClientChannel(event),
        IpcChannel.Conversations.changed,
        conversation.id
      )
    } catch (error) {
      log.error('Failed to save conversation:', conversation.id, error)
      throw new Error('Could not save conversation.')
    }
  })

  ipcMain.handle(IpcChannel.Conversations.delete, (_event, id: string) => {
    try {
      conversationStore.delete(id)
    } catch (error) {
      log.error('Failed to delete conversation:', id, error)
      throw new Error('Could not delete conversation.')
    }
  })

  ipcMain.handle(IpcChannel.Conversations.restore, (_event, id: string) => {
    try {
      conversationStore.restore(id)
    } catch (error) {
      log.error('Failed to restore conversation:', id, error)
      throw new Error('Could not restore conversation.')
    }
  })

  ipcMain.handle(IpcChannel.Conversations.deletePermanent, (_event, id: string) => {
    try {
      conversationStore.deletePermanent(id)
    } catch (error) {
      log.error('Failed to permanently delete conversation:', id, error)
      throw new Error('Could not permanently delete conversation.')
    }
  })

  ipcMain.handle(IpcChannel.Conversations.deleteAll, () => {
    try {
      conversationStore.deleteAll()
    } catch (error) {
      log.error('Failed to delete all conversations:', error)
      throw new Error('Could not delete all conversations.')
    }
  })

  ipcMain.handle(IpcChannel.Conversations.deleteArchived, (_event, ids: string[]) => {
    try {
      conversationStore.deleteArchived(ids)
    } catch (error) {
      log.error('Failed to delete archived conversations:', error)
      throw new Error('Could not delete archived conversations.')
    }
  })

  ipcMain.handle(IpcChannel.Conversations.getState, () => conversationStore.getState())

  ipcMain.handle(IpcChannel.Conversations.setState, (_event, state: ConversationState) => {
    try {
      conversationStore.setState(state)
    } catch (error) {
      log.error('Failed to save conversation state:', error)
      throw new Error('Could not save conversation state.')
    }
  })

  ipcMain.handle(
    IpcChannel.Conversations.readVisualPreview,
    async (_event, conversationId: string, assetId: string) => {
      try {
        return ok(await conversationAssetStore.readImage(conversationId, assetId))
      } catch (error) {
        log.warn('Failed to read visual preview:', conversationId, assetId, error)
        return err(
          'conversations.visual-preview-unavailable',
          'This inspected screenshot is no longer available.',
          toErrorMessage(error)
        )
      }
    }
  )

  ipcMain.handle(IpcChannel.Conversations.getVisualPreviewUsage, async () => {
    try {
      return ok(await conversationAssetStore.getUsage())
    } catch (error) {
      log.warn('Failed to read visual preview usage:', error)
      return err(
        'conversations.visual-preview-usage-failed',
        'Could not read visual preview storage usage.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.Conversations.clearVisualPreviews, async () => {
    try {
      return ok(await conversationAssetStore.clearAll())
    } catch (error) {
      log.warn('Failed to clear visual previews:', error)
      return err(
        'conversations.visual-preview-clear-failed',
        'Could not clear visual previews.',
        toErrorMessage(error)
      )
    }
  })
}

/**
 * A conversation minus its messages.
 *
 * `messageCount` rather than the messages themselves: a list shows how long a
 * conversation is, never what is in it, and the messages are the entire reason the
 * full store is too large to send anywhere.
 */
function toSummary(conversation: Conversation): ConversationSummary {
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    archived: conversation.archived,
    // So a caller can tell a chat somebody had from a run the machine did. The
    // phone's recents list is the reason: without this every scheduled run and
    // benchmark script sat in it looking exactly like a conversation.
    origin: conversation.origin
  }
}
