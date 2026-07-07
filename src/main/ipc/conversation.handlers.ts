import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { Conversation, ConversationState } from '@shared/conversation.types'
import { conversationStore } from '../conversations/ConversationStore'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:conversations')

/** IPC handlers for conversation persistence. */
export function registerConversationHandlers(): void {
  ipcMain.handle(IpcChannel.Conversations.list, () => conversationStore.list())

  ipcMain.handle(IpcChannel.Conversations.save, (_event, conversation: Conversation) => {
    try {
      conversationStore.save(conversation)
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

  ipcMain.handle(IpcChannel.Conversations.deleteAll, () => {
    try {
      conversationStore.deleteAll()
    } catch (error) {
      log.error('Failed to delete all conversations:', error)
      throw new Error('Could not delete all conversations.')
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
}
