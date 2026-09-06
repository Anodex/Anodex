import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron'
import { IpcChannel } from '@shared/ipc'
import { ok, err, toErrorMessage } from '@shared/result'
import type { ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import { settingsStore } from '../settings/SettingsStore'
import type { ClientChannel } from '../clients/ClientChannel'
import { activeRemoteClients } from '../clients/clientRegistry'
import { notifyRemoteClients } from '../notify'

/** Approval prompts awaiting a renderer response, keyed by request id. */
const pendingConfirmations = new Map<string, (response: ToolConfirmResponse) => void>()

/**
 * How long an approval prompt waits before denying itself.
 *
 * A prompt with no deadline is fine while the only client is a window on the
 * screen in front of you. It is not fine once a phone can be the one holding it:
 * a phone that leaves Wi-Fi mid-prompt takes the answer with it, and
 * `requestToolConfirmation` returns a promise that would otherwise never settle —
 * wedging that generation for the rest of the session, on a machine the user may
 * not be near.
 *
 * Auto-denying is the safe end of that. A denied tool call is a turn the user can
 * retry; an approval nobody gave is not something to invent on their behalf.
 */
export const CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000

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
 * Every client that should see an approval prompt: whoever asked, plus any paired phone.
 *
 * A confirmation is a question to *the user*, not to a window, and the user may
 * be at either screen. `pendingConfirmations` is already keyed by request id and
 * `Tools.confirmResponse` already ignores its event, so any client that knows
 * the id can answer — whichever does settles it, and `confirmCancelled` drops
 * the other card. Only the fan-out was missing.
 *
 * De-duplicated by channel id so the asker is not sent the same prompt twice if
 * it is also a registered remote client.
 */
function confirmationAudience(asker: ClientChannel): ClientChannel[] {
  const audience = new Map<string, ClientChannel>()
  audience.set(asker.id, asker)
  for (const client of activeRemoteClients()) audience.set(client.id, client)
  return [...audience.values()]
}

/**
 * Ask the user to approve a write/command and wait for their decision.
 * Resolves to a denial if every client is gone or the generation is aborted
 * while the prompt is open, so a stalled approval never hangs the model.
 */
export function requestToolConfirmation(
  asker: ClientChannel,
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
    const audience = confirmationAudience(asker).filter((client) => client.isAlive())
    if (audience.length === 0) {
      // Nobody is listening, so nobody can answer. Denying is the safe reading:
      // an unanswerable prompt must not become an implicit approval.
      resolve({ approved: false })
      return
    }
    /** Returns whether this call actually settled the request (false if it was already answered). */
    const settle = (response: ToolConfirmResponse): boolean => {
      if (!pendingConfirmations.has(request.id)) return false
      pendingConfirmations.delete(request.id)
      // Declared below and closed over: `settle` is only ever reached asynchronously,
      // so the timer exists by the time any caller can get here. Clearing it here
      // means every route out — a click, an abort, the timeout itself — stops it.
      clearTimeout(expiry)
      if (response.approved && response.remember && request.risk !== 'destructive') {
        rememberedToolApprovals.add(approvalKey(request.toolName, request.conversationId))
      }
      resolve(response)
      return true
    }
    pendingConfirmations.set(request.id, settle)

    const expiry = setTimeout(() => {
      const settledHere = settle({
        approved: false,
        reason: 'Nobody answered this in time, so it was declined.'
      })
      // Same reasoning as the abort path below: every client is now showing a card
      // whose buttons would silently do nothing, because the id has already gone.
      if (settledHere) {
        for (const client of audience) {
          client.send(IpcChannel.Tools.confirmCancelled, request.id)
        }
      }
    }, CONFIRMATION_TIMEOUT_MS)

    // Node holds the process open for a pending timer, so a five-minute one would
    // keep a quitting app alive for up to five minutes.
    expiry.unref?.()

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
        if (settledHere) {
          for (const client of audience) {
            client.send(IpcChannel.Tools.confirmCancelled, request.id)
          }
        }
      },
      { once: true }
    )
    for (const client of audience) client.send(IpcChannel.Tools.confirmRequest, request)

    // The fifth notification source, and the most valuable one (§6.2). Everything
    // else the phone reports can wait until the user is back at the desk; a run
    // blocked on approval is stopped until somebody answers, and the whole point
    // of carrying the phone is to be able to answer.
    //
    // Only for remote clients: the desktop is already showing the card itself, and
    // a toast about a prompt on screen is noise.
    if (activeRemoteClients().length > 0) {
      notifyRemoteClients({
        kind: 'needs-approval',
        title: 'Anodex needs an answer',
        // Deliberately thin. This lands on a lock screen, and §2 says the phone
        // does not hold the user's data — the tool's arguments stay in the app.
        body: request.title,
        conversationId: request.conversationId,
        atEpochMs: Date.now()
      })
    }
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

/** Test seam: how many prompts are still waiting for an answer. */
export function pendingConfirmationCountForTests(): number {
  return pendingConfirmations.size
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
