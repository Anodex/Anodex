import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { broadcastToWindows } from '../broadcast'
import { updateService } from '../updates/UpdateService'
import { fetchReleaseNotes } from '../updates/releaseNotes'
import { anodexVersion } from '../appVersion'

/** Register IPC handlers for the auto-updater and broadcast status changes. */
export function registerUpdateHandlers(): void {
  ipcMain.handle(IpcChannel.Updates.getStatus, () => updateService.getStatus())
  ipcMain.handle(IpcChannel.Updates.getReleaseNotes, () => fetchReleaseNotes(anodexVersion))
  ipcMain.handle(IpcChannel.Updates.check, () => updateService.check())
  ipcMain.handle(IpcChannel.Updates.download, () => updateService.download())
  ipcMain.handle(IpcChannel.Updates.installAndRestart, () => updateService.installAndRestart())

  updateService.on('status', (status) => {
    broadcastToWindows(IpcChannel.Updates.statusChanged, status)
  })
}
