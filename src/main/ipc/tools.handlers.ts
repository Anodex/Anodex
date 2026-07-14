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
  // A `turnGate: true` request exists specifically to be this turn's own
  // "first action" checkpoint (see `needsTurnGate` in `permissions.ts`) — a
  // remembered "Always allow this tool" from an earlier turn is about trust
  // in that specific tool, not an opt-out of the once-per-turn checkpoint
  // itself, so it must not silently satisfy this one.
  if (
    !request.turnGate &&
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
    /** Returns whether this call actually settled the request (false if it was already answered). */
    const settle = (response: ToolConfirmResponse): boolean => {
      if (!pendingConfirmations.has(request.id)) return false
      pendingConfirmations.delete(request.id)
      if (response.approved && response.remember && request.risk !== 'destructive') {
        rememberedToolApprovals.add(approvalKey(request.toolName, request.conversationId))
      }
      resolve(response)
      return true
    }
    pendingConfirmations.set(request.id, settle)
    signal?.addEventListener(
      'abort',
      () => {
        const settledHere = settle({
          approved: false,
          reason: 'The generation was cancelled.'
        })
        // The renderer's own card for this request is now showing a dead
        // prompt — the main side has already answered on its behalf, so a
        // later click on "Approve"/"Deny" would silently no-op (the id is
        // gone from `pendingConfirmations` above). Tell it to drop the card
        // instead of leaving it sitting there forever. Only when this abort
        // is what actually settled it — if the user already answered before
        // the abort fired, their own click already removed the card client-side.
        if (settledHere && !sender.isDestroyed()) {
          sender.send(IpcChannel.Tools.confirmCancelled, request.id)
        }
      },
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
