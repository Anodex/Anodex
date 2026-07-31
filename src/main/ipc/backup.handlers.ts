import { BrowserWindow, ipcMain, shell } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { err, ok, toErrorMessage } from '@shared/result'
import type { Conversation } from '@shared/conversation.types'
import type { ConversationExportFormat } from '@shared/backup.types'
import { backupUserData, exportConversation } from '../backup/BackupService'

/** IPC for exporting a single chat and for backing up the whole data directory. */
export function registerBackupHandlers(): void {
  ipcMain.handle(
    IpcChannel.Backup.exportConversation,
    async (event, conversation: Conversation, format: ConversationExportFormat) => {
      try {
        const path = await exportConversation(
          BrowserWindow.fromWebContents(event.sender),
          conversation,
          format
        )
        return ok(path)
      } catch (error) {
        return err('backup.export-failed', 'Could not export this chat.', toErrorMessage(error))
      }
    }
  )

  ipcMain.handle(IpcChannel.Backup.backupData, async (event) => {
    try {
      return ok(await backupUserData(BrowserWindow.fromWebContents(event.sender)))
    } catch (error) {
      return err('backup.backup-failed', 'Could not back up your data.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Backup.revealPath, (_event, path: string) => {
    shell.showItemInFolder(path)
  })
}
