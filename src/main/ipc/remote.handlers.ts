import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { ok, err, toErrorMessage } from '@shared/result'
import { broadcastToWindows } from '../broadcast'
import { createLogger } from '../utils/logger'
import { remoteService } from '../remote/RemoteService'

const log = createLogger('ipc:remote')

/**
 * IPC for Settings → Remote.
 *
 * Every one of these is refused to a remote client by `channelPolicy`'s
 * `settings:`-style rules — except that these live under `remote:`, so they are
 * listed explicitly below. A phone that could turn the listener off, unpair
 * itself, or mint a new pairing code would be able to rewrite the very
 * conditions under which it is allowed to talk at all.
 */
export function registerRemoteHandlers(): void {
  ipcMain.handle(IpcChannel.Remote.status, () => remoteService.status())

  ipcMain.handle(IpcChannel.Remote.setEnabled, async (_event, enabled: boolean) => {
    try {
      const status = await remoteService.setEnabled(enabled)
      broadcastToWindows(IpcChannel.Remote.statusChanged, status)
      return ok(status)
    } catch (error) {
      log.error('could not change the remote listener:', error)
      return err('remote.toggle-failed', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Remote.beginPairing, () => remoteService.beginPairing())

  ipcMain.handle(IpcChannel.Remote.cancelPairing, () => {
    remoteService.cancelPairing()
  })

  ipcMain.handle(IpcChannel.Remote.revoke, () => {
    const status = remoteService.revoke()
    broadcastToWindows(IpcChannel.Remote.statusChanged, status)
    return status
  })
}
