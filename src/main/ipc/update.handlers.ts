import { BrowserWindow, ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { updateService } from '../updates/UpdateService'

/** Register IPC handlers for the auto-updater and broadcast status changes. */
export function registerUpdateHandlers(): void {
  ipcMain.handle(IpcChannel.Updates.getStatus, () => updateService.getStatus())
  ipcMain.handle(IpcChannel.Updates.check, () => updateService.check())
  ipcMain.handle(IpcChannel.Updates.download, () => updateService.download())
  ipcMain.handle(IpcChannel.Updates.installAndRestart, () => updateService.installAndRestart())

  updateService.on('status', (status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IpcChannel.Updates.statusChanged, status)
    }
  })
}
