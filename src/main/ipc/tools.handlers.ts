import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type WebContents
} from 'electron'
import { IpcChannel } from '@shared/ipc'
import { ok, err, toErrorMessage } from '@shared/result'
import type { ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import { settingsStore } from '../settings/SettingsStore'

/** Approval prompts awaiting a renderer response, keyed by request id. */
const pendingConfirmations = new Map<string, (response: ToolConfirmResponse) => void>()

/**
 * Session-only allowlist for the "Always allow this tool" approval action.
 * Kept in the main process, rather than the renderer, so the same permission
 * policy that decided a prompt was needed also decides whether it can be
 * skipped later. Destructive calls are intentionally never remembered.
 */
const rememberedToolApprovals = new Set<string>()

/**
 * Ask the renderer to approve a write/command and wait for the user's decision.
 * Resolves to a denial if the window is gone or the generation is aborted while
 * the prompt is open, so a stalled approval never hangs the model.
 */
export function requestToolConfirmation(
  sender: WebContents,
  request: ToolConfirmRequest,
  signal?: AbortSignal
): Promise<ToolConfirmResponse> {
  if (request.risk !== 'destructive' && rememberedToolApprovals.has(request.toolName)) {
    return Promise.resolve({ approved: true })
  }

  return new Promise((resolve) => {
    if (sender.isDestroyed()) {
      resolve({ approved: false })
      return
    }
    const settle = (response: ToolConfirmResponse): void => {
      if (!pendingConfirmations.has(request.id)) return
      pendingConfirmations.delete(request.id)
      if (response.approved && response.remember && request.risk !== 'destructive') {
        rememberedToolApprovals.add(request.toolName)
      }
      resolve(response)
    }
    pendingConfirmations.set(request.id, settle)
    signal?.addEventListener(
      'abort',
      () => settle({ approved: false, reason: 'The generation was cancelled.' }),
      { once: true }
    )
    sender.send(IpcChannel.Tools.confirmRequest, request)
  })
}

export function resolvePendingConfirmationForTests(
  id: string,
  response: ToolConfirmResponse
): void {
  pendingConfirmations.get(id)?.(response)
}

export function resetToolApprovalStateForTests(): void {
  pendingConfirmations.clear()
  rememberedToolApprovals.clear()
}

async function pickDirectory(event: IpcMainInvokeEvent): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(event.sender)
  const options: OpenDialogOptions = {
    title: 'Select a project folder',
    properties: ['openDirectory']
  }
  const picked = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)

  if (picked.canceled || !picked.filePaths[0]) return null
  return picked.filePaths[0]
}

/** IPC handlers for linking project folders and approval responses. */
export function registerToolHandlers(): void {
  ipcMain.handle(
    IpcChannel.Tools.confirmResponse,
    (_event, id: string, response: ToolConfirmResponse) => {
      pendingConfirmations.get(id)?.(response)
    }
  )

  // Used by project creation surfaces that immediately activate the new project.
  // Keep the workspace update here for backward compatibility with those flows.
  ipcMain.handle(IpcChannel.Tools.pickWorkspace, async (event) => {
    try {
      const root = await pickDirectory(event)
      if (!root) return ok(null)
      settingsStore.update({ workspace: { root } })
      return ok(root)
    } catch (error) {
      return err('tools.workspace-failed', 'Could not set the workspace.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Tools.pickFolder, async (event) => {
    try {
      return ok(await pickDirectory(event))
    } catch (error) {
      return err(
        'tools.folder-picker-failed',
        'Could not select the folder.',
        toErrorMessage(error)
      )
    }
  })
}
