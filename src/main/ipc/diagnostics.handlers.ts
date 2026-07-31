import { ipcMain, shell } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { DiagnosticEntry, DiagnosticLogFile } from '@shared/settings.types'
import { diagnosticsReporter } from '../diagnostics/DiagnosticsReporter'
import { getLogFileInfo } from '../diagnostics/logFile'

/**
 * IPC surface for the Diagnostics page. The live push side is wired in
 * `DiagnosticsReporter` itself (it broadcasts as it records, including before
 * these handlers exist), so there's nothing to subscribe to here.
 */
export function registerDiagnosticsHandlers(): void {
  ipcMain.handle(IpcChannel.Diagnostics.list, (): DiagnosticEntry[] => diagnosticsReporter.list())

  ipcMain.handle(IpcChannel.Diagnostics.getLogFile, (): DiagnosticLogFile => getLogFileInfo())

  ipcMain.handle(IpcChannel.Diagnostics.revealLogFile, (): void => {
    const { path, available } = getLogFileInfo()
    if (!path || !available) return
    shell.showItemInFolder(path)
  })
}
