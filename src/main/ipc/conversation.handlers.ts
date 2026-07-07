import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { Conversation, ConversationState } from '@shared/conversation.types'
import { conversationStore } from '../conversations/ConversationStore'

/** IPC handlers for conversation persistence. */
export function registerConversationHandlers(): void {
  ipcMain.handle(IpcChannel.Conversations.list, () => conversationStore.list())

  ipcMain.handle(IpcChannel.Conversations.save, (_event, conversation: Conversation) =>
    conversationStore.save(conversation)
  )

  ipcMain.handle(IpcChannel.Conversations.delete, (_event, id: string) =>
    conversationStore.delete(id)
  )

  ipcMain.handle(IpcChannel.Conversations.deleteAll, () => {
    try {
      conversationStore.deleteAll()
    } catch {
      throw new Error('Could not delete all conversations.')
    }
  })

  ipcMain.handle(IpcChannel.Conversations.getState, () => conversationStore.getState())

  ipcMain.handle(IpcChannel.Conversations.setState, (_event, state: ConversationState) =>
    conversationStore.setState(state)
  )
}
