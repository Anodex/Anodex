import { extname } from 'node:path'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { ipcMain, shell } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { ok, err, toErrorMessage } from '@shared/result'
import { settingsStore } from '../settings/SettingsStore'
import { projectStore } from '../projects/ProjectStore'
import { listWorkspaceFiles } from '../workspace/listWorkspaceFiles'
import { resolveInWorkspace } from '../tools/workspace'
import { prepareHtmlPreviewSource } from '../tools/previewTools'
import {
  hasHtmlPreviewWindow,
  openHtmlPreviewWindow,
  refreshHtmlPreviewWindow
} from '../htmlPreviewWindow'
import { isImagePath, isLikelyBinary } from './attachments.handlers'
import { computerControlService } from '../computerControl/ComputerControlService'

/** Files larger than this aren't loaded into the in-app viewer/editor — generous for real
 *  source files, protects textarea/highlight performance against something huge. */
const MAX_EDITABLE_BYTES = 5 * 1024 * 1024

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml'
}

export function imageMimeType(path: string): string {
  return IMAGE_MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

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

  ipcMain.handle(IpcChannel.Workspace.readFileContent, async (_event, relativePath: string) => {
    const root = settingsStore.get().workspace.root
    if (!root) return err('workspace.no-root', 'No workspace folder is selected.')
    try {
      const file = resolveInWorkspace(root, relativePath)
      const info = await stat(file)
      if (info.size > MAX_EDITABLE_BYTES) {
        return ok({ kind: 'too-large', sizeBytes: info.size } as const)
      }
      const buffer = await readFile(file)
      if (isImagePath(file)) {
        const dataUrl = `data:${imageMimeType(file)};base64,${buffer.toString('base64')}`
        return ok({ kind: 'image', dataUrl } as const)
      }
      if (isLikelyBinary(buffer)) return ok({ kind: 'binary' } as const)
      return ok({ kind: 'text', content: buffer.toString('utf-8') } as const)
    } catch (error) {
      return err(
        'workspace.read-content-failed',
        'Could not read that file.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(
    IpcChannel.Workspace.writeFileContent,
    async (_event, relativePath: string, content: string) => {
      const root = settingsStore.get().workspace.root
      if (!root) return err('workspace.no-root', 'No workspace folder is selected.')
      try {
        const file = resolveInWorkspace(root, relativePath)
        await writeFile(file, content, 'utf-8')
        return ok(undefined)
      } catch (error) {
        return err(
          'workspace.write-content-failed',
          'Could not save that file.',
          toErrorMessage(error)
        )
      }
    }
  )

  ipcMain.handle(
    IpcChannel.Workspace.prepareHtmlPreview,
    async (_event, relativePath: string, html: string) => {
      const root = settingsStore.get().workspace.root
      if (!root) return err('workspace.no-root', 'No workspace folder is selected.')
      try {
        return ok(await prepareHtmlPreviewSource(root, relativePath, html))
      } catch (error) {
        return err(
          'workspace.prepare-preview-failed',
          'Could not build a preview for that page.',
          toErrorMessage(error)
        )
      }
    }
  )

  ipcMain.handle(
    IpcChannel.Workspace.openHtmlPreviewWindow,
    async (_event, relativePath: string, title: string, html: string) => {
      const root = settingsStore.get().workspace.root
      if (!root) return err('workspace.no-root', 'No workspace folder is selected.')
      try {
        const content = await prepareHtmlPreviewSource(root, relativePath, html)
        openHtmlPreviewWindow(relativePath, title, content, root)
        return ok(undefined)
      } catch (error) {
        return err(
          'workspace.preview-window-failed',
          'Could not open a preview window for that page.',
          toErrorMessage(error)
        )
      }
    }
  )

  // Separate from `openHtmlPreviewWindow` so the file viewer can keep an
  // already-open pop-out in sync as the buffer (or the AI) changes the file,
  // without that ever popping a window back up after the user closed it.
  ipcMain.handle(
    IpcChannel.Workspace.refreshHtmlPreviewWindow,
    async (_event, relativePath: string, html: string) => {
      if (!hasHtmlPreviewWindow(relativePath)) return ok(false)
      const root = settingsStore.get().workspace.root
      if (!root) return ok(false)
      try {
        // A reload replaces the exact document the model was observing. It is
        // never safe for an existing coordinate session to continue into it.
        computerControlService.stopTarget(relativePath, 'target-reloaded')
        refreshHtmlPreviewWindow(
          relativePath,
          await prepareHtmlPreviewSource(root, relativePath, html)
        )
        return ok(true)
      } catch (error) {
        return err(
          'workspace.preview-window-failed',
          'Could not refresh that preview window.',
          toErrorMessage(error)
        )
      }
    }
  )
}
