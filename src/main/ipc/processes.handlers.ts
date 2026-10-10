import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { broadcastToWindows } from '../broadcast'
import { backgroundProcessService } from '../processes/BackgroundProcessService'

/** Output the dock shows for one process: enough to see a URL or an error. */
const DOCK_OUTPUT_CHARS = 16 * 1024

/** IPC for the dock's view of background processes. */
export function registerProcessHandlers(): void {
  ipcMain.handle(IpcChannel.Processes.list, (_event, projectId: string | null) =>
    backgroundProcessService.list(projectId ?? null)
  )
  ipcMain.handle(
    IpcChannel.Processes.output,
    (_event, id: string) => backgroundProcessService.output(id, DOCK_OUTPUT_CHARS)?.text ?? ''
  )
  ipcMain.handle(IpcChannel.Processes.stop, async (_event, id: string) => {
    await backgroundProcessService.stop(id)
  })
  backgroundProcessService.onChange((info) =>
    broadcastToWindows(IpcChannel.Processes.changed, info)
  )
}
