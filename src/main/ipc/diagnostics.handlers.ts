import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IpcChannel } from '@shared/ipc'
import { err, ok, toErrorMessage } from '@shared/result'
import type { DiagnosticEntry, DiagnosticLogFile } from '@shared/settings.types'
import { diagnosticsReporter } from '../diagnostics/DiagnosticsReporter'
import { getLogFileInfo } from '../diagnostics/logFile'
import { createSupportBundlePreview } from '../diagnostics/SupportBundleService'

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

  ipcMain.handle(IpcChannel.Diagnostics.getSupportBundlePreview, async () => {
    try {
      return ok(await createSupportBundlePreview())
    } catch (error) {
      return err(
        'diagnostics.support-bundle-preview-failed',
        'Could not prepare the support bundle.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.Diagnostics.saveSupportBundle, async (event) => {
    try {
      // Rebuild immediately before saving. The renderer only receives a
      // redacted preview, and never gets authority to choose the file content.
      const bundle = await createSupportBundlePreview()
      const parent = BrowserWindow.fromWebContents(event.sender)
      const selection = parent
        ? await dialog.showSaveDialog(parent, {
            title: 'Save support bundle',
            defaultPath: join(app.getPath('documents'), bundle.fileName),
            filters: [{ name: 'Text report', extensions: ['txt'] }]
          })
        : await dialog.showSaveDialog({
            title: 'Save support bundle',
            defaultPath: join(app.getPath('documents'), bundle.fileName),
            filters: [{ name: 'Text report', extensions: ['txt'] }]
          })
      if (selection.canceled || !selection.filePath) return ok({ path: null })

      const filePath = selection.filePath.toLowerCase().endsWith('.txt')
        ? selection.filePath
        : `${selection.filePath}.txt`
      await writeFile(filePath, bundle.content, 'utf-8')
      return ok({ path: filePath })
    } catch (error) {
      return err(
        'diagnostics.support-bundle-save-failed',
        'Could not save the support bundle.',
        toErrorMessage(error)
      )
    }
  })
}
