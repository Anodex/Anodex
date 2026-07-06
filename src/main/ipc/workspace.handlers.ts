import { ipcMain, shell } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { ok, err, toErrorMessage } from '@shared/result'
import { settingsStore } from '../settings/SettingsStore'
import { projectStore } from '../projects/ProjectStore'
import { listWorkspaceFiles } from '../workspace/listWorkspaceFiles'
import { resolveInWorkspace } from '../tools/workspace'

/** IPC handlers for the Files dock panel. */
export function registerWorkspaceHandlers(): void {
  ipcMain.handle(IpcChannel.Workspace.listFiles, async () => {
    try {
      const root = settingsStore.get().workspace.root
      if (!root) return ok([])
      const projectId = projectStore.getState().activeProjectId
      return ok(await listWorkspaceFiles(root, projectId))
    } catch (error) {
      return err(
        'workspace.list-files-failed',
        'Could not list workspace files.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.Workspace.getAbsolutePath, (_event, relativePath: string) => {
    const root = settingsStore.get().workspace.root
    if (!root) return err('workspace.no-root', 'No workspace folder is selected.')
    try {
      return ok(resolveInWorkspace(root, relativePath))
    } catch (error) {
      return err('workspace.resolve-failed', 'Could not resolve that path.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Workspace.revealInFileExplorer, (_event, relativePath: string) => {
    const root = settingsStore.get().workspace.root
    if (!root) return err('workspace.no-root', 'No workspace folder is selected.')
    try {
      shell.showItemInFolder(resolveInWorkspace(root, relativePath))
      return ok(undefined)
    } catch (error) {
      return err(
        'workspace.reveal-failed',
        'Could not open the file explorer.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.Workspace.openPath, async (_event, relativePath: string) => {
    const root = settingsStore.get().workspace.root
    if (!root) return err('workspace.no-root', 'No workspace folder is selected.')
    try {
      const target = resolveInWorkspace(root, relativePath)
      // Unusually for this codebase's convention, `shell.openPath` reports
      // failure via its resolved string rather than a thrown error/rejection.
      const failure = await shell.openPath(target)
      if (failure) return err('workspace.open-failed', 'Could not open that file.', failure)
      return ok(undefined)
    } catch (error) {
      return err('workspace.open-failed', 'Could not open that file.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Workspace.deletePath, async (_event, relativePath: string) => {
    const root = settingsStore.get().workspace.root
    if (!root) return err('workspace.no-root', 'No workspace folder is selected.')
    try {
      // Moves to the OS Recycle Bin/Trash rather than permanently deleting —
      // recoverable if a user (or the confirmation dialog) gets it wrong.
      await shell.trashItem(resolveInWorkspace(root, relativePath))
      return ok(undefined)
    } catch (error) {
      return err('workspace.delete-failed', 'Could not delete that item.', toErrorMessage(error))
    }
  })
}
