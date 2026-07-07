import { ipcMain, BrowserWindow } from 'electron'
import { IpcChannel } from '@shared/ipc'

/** Register IPC handlers for window controls (minimize, maximize, close). */
export function registerWindowHandlers(): void {
  ipcMain.handle(IpcChannel.Window.minimize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.minimize()
  })

  ipcMain.handle(IpcChannel.Window.maximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })

  ipcMain.handle(IpcChannel.Window.close, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.close()
  })

  ipcMain.handle(IpcChannel.Window.isMaximized, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? win.isMaximized() : false
  })
}
