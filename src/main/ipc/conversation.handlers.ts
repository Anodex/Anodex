import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { broadcastToWindows } from '../broadcast'
import { isRemoteCall } from '../clients/clientRegistry'
import type {
  Conversation,
  ConversationState,
  ConversationSummary
} from '@shared/conversation.types'
import { err, ok, toErrorMessage } from '@shared/result'
import { conversationStore } from '../conversations/ConversationStore'
import { conversationAssetStore } from '../conversations/ConversationAssetStore'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:conversations')

/** IPC handlers for conversation persistence. */
export function registerConversationHandlers(): void {
  ipcMain.handle(IpcChannel.Conversations.list, () => conversationStore.list())

  ipcMain.handle(IpcChannel.Conversations.listSummaries, () =>
    conversationStore.list().map(toSummary)
  )

  ipcMain.handle(IpcChannel.Conversations.get, (_event, conversationId: string, limit?: number) => {
    const conversation = conversationStore.get(conversationId)
    if (!conversation) return null
    if (limit == null || conversation.messages.length <= limit) return conversation

    // The tail, because that is what a reader wants and what a model was last
    // talking about. Sending the head of a thousand-turn conversation is both
    // larger and less useful.
    return { ...conversation, messages: conversation.messages.slice(-limit) }
  })

  ipcMain.handle(IpcChannel.Conversations.listArchived, () => conversationStore.listArchived())

  ipcMain.handle(IpcChannel.Conversations.save, (event, conversation: Conversation) => {
    try {
      conversationStore.save(conversation)

      // A phone can now write conversations, and the desktop had no way to hear
      // about it — a chat started on the phone simply did not exist here until
      // Anodex was restarted. Only remote saves are announced: a renderer that made
      // the change already knows, and echoing it back would fight its own local
      // state in the middle of an edit.
      if (isRemoteCall(event)) {
        broadcastToWindows(IpcChannel.Conversations.changed, conversation.id)
      }
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
    archived: conversation.archived
  }
}
