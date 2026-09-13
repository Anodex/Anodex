import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { broadcastToWindows } from '../broadcast'
import { isRemoteCall, resolveClientChannel } from '../clients/clientRegistry'
import { remoteService } from '../remote/RemoteService'

/**
 * Paired devices, listed, renamed and unpaired from a paired phone.
 *
 * See `IpcChannel.Devices` for why these are reachable from a phone when `remote:`
 * is not: nothing here can add a device, open a pairing window or change whether the
 * computer listens. Every change is announced to the desktop's Settings too.
 */
export function registerDevicesHandlers(): void {
  ipcMain.handle(IpcChannel.Devices.list, (event) =>
    remoteService.deviceSummaries(askingDevice(event))
  )

  ipcMain.handle(IpcChannel.Devices.rename, (event, deviceId: unknown, name: unknown) => {
    if (typeof deviceId === 'string' && typeof name === 'string' && name.trim()) {
      broadcastToWindows(
        IpcChannel.Remote.statusChanged,
        remoteService.renameDevice(deviceId, name)
      )
    }
    return remoteService.deviceSummaries(askingDevice(event))
  })

  ipcMain.handle(IpcChannel.Devices.unpair, (event, deviceId: unknown) => {
    const asking = askingDevice(event)
    if (typeof deviceId === 'string') {
      broadcastToWindows(IpcChannel.Remote.statusChanged, remoteService.revoke(deviceId))
    }
    return remoteService.deviceSummaries(asking)
  })
}

/** The paired device making this call, or null for the desktop's own window. */
function askingDevice(event: unknown): string | null {
  if (!isRemoteCall(event)) return null
  const id = resolveClientChannel(event).id
  return id.startsWith('remote:') ? id.slice('remote:'.length) : null
}
