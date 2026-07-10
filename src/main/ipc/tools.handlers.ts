import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions, type WebContents } from 'electron'
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
 *
 * Scoped per (tool, conversation) rather than tool alone — approving
 * `edit_file` once in a throwaway chat shouldn't silently blanket-approve
 * every future `edit_file` call across every other conversation for the
 * rest of the session.
 */
const rememberedToolApprovals = new Set<string>()

function approvalKey(toolName: string, conversationId: string): string {
  return `${toolName}::${conversationId}`
}

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
  if (
    request.risk !== 'destructive' &&
    rememberedToolApprovals.has(approvalKey(request.toolName, request.conversationId))
  ) {
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
        rememberedToolApprovals.add(approvalKey(request.toolName, request.conversationId))
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

/** IPC handlers for linking a project folder and approval responses. */
export function registerToolHandlers(): void {
  ipcMain.handle(
    IpcChannel.Tools.confirmResponse,
    (_event, id: string, response: ToolConfirmResponse) => {
      pendingConfirmations.get(id)?.(response)
    }
  )

  // Only ever called when linking a new project's folder (`ProjectsSettings.tsx`) —
  // there's no standalone "set a workspace" path outside a project anymore.
  ipcMain.handle(IpcChannel.Tools.pickWorkspace, async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: OpenDialogOptions = {
        title: 'Select a project folder',
        properties: ['openDirectory']
      }
      const picked = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)

      if (picked.canceled || !picked.filePaths[0]) return ok(null)
      const root = picked.filePaths[0]
      settingsStore.update({ workspace: { root } })
      return ok(root)
    } catch (error) {
      return err('tools.workspace-failed', 'Could not set the workspace.', toErrorMessage(error))
    }
  })
}
