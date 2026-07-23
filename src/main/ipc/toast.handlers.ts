import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { ToastContent } from '@shared/toast.types'
import { showToastWindow } from '../toastWindow'
import { getMainWindow } from '../window'
import { sendToWindow } from '../broadcast'

/** Register IPC handlers for the custom desktop toast window. */
export function registerToastHandlers(): void {
  ipcMain.handle(IpcChannel.Toast.show, (_event, content: ToastContent) => {
    showToastWindow(content)
  })

  ipcMain.handle(IpcChannel.Toast.focusMain, (_event, conversationId?: string) => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (conversationId) sendToWindow(win, IpcChannel.Toast.openConversation, conversationId)
  })
}
