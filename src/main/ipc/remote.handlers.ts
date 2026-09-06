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
  // Pairing happens on the phone, so the desktop learns about it from the bridge
  // rather than from a click. Settings is watching this screen when it happens.
  remoteService.onStatusChanged = (status) => {
    broadcastToWindows(IpcChannel.Remote.statusChanged, status)
  }

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

  ipcMain.handle(IpcChannel.Remote.setInternetAccess, async (_event, enabled: boolean) => {
    try {
      const status = await remoteService.setInternetAccess(enabled)
      broadcastToWindows(IpcChannel.Remote.statusChanged, status)
      return ok(status)
    } catch (error) {
      log.error('could not change internet access:', error)
      return err('remote.internet-failed', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Remote.setPort, async (_event, port: number) => {
    try {
      const status = await remoteService.setPort(port)
      broadcastToWindows(IpcChannel.Remote.statusChanged, status)
      return ok(status)
    } catch (error) {
      log.error('could not change the remote port:', error)
      return err('remote.port-failed', toErrorMessage(error))
    }
  })

  ipcMain.handle(
    IpcChannel.Remote.setManualAddress,
    async (_event, address: string | null, port: number | null) => {
      try {
        const status = await remoteService.setManualExternalAddress(address, port)
        broadcastToWindows(IpcChannel.Remote.statusChanged, status)
        return ok(status)
      } catch (error) {
        log.error('could not save the manual address:', error)
        return err('remote.manual-address-failed', toErrorMessage(error))
      }
    }
  )
}
