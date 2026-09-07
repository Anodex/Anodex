import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { RemotePersonalityState } from '@shared/personality.types'
import { broadcastToWindows } from '../broadcast'
import { isRemoteCall } from '../clients/clientRegistry'
import { settingsStore } from '../settings/SettingsStore'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:personality')

/**
 * Choosing how Anodex answers, from a phone.
 *
 * Two channels of its own rather than letting a phone near `settings:`, which is
 * denied to remote clients as a whole and should stay that way — that prefix
 * carries the permission mode, the MCP servers and the model directory, and a
 * client that can write to it can dismantle the protections that let it connect.
 *
 * The personality is not that. It changes the wording of a system prompt and
 * nothing else, and it is the one assistant setting somebody genuinely wants to
 * change from the sofa. So it gets a door exactly its own size: a read, and a write
 * that can set precisely one field to one of a known set of values.
 *
 * The same carve-out shape as `models:get-state`, and for the same reason — deny the
 * prefix, then allow back the one thing that is safe and useful.
 */
export function registerPersonalityHandlers(): void {
  ipcMain.handle(IpcChannel.Personality.list, () => stateOf())

  ipcMain.handle(IpcChannel.Personality.setActive, (event, id: string | null) => {
    // Validated against what actually exists rather than trusted. `null` is
    // meaningful — it selects the free-text style instead of a named personality —
    // so it cannot simply be rejected as absent.
    if (id !== null) {
      const known = settingsStore.get().assistantStyle.personalities
      if (!known.some((personality) => personality.id === id)) {
        throw new Error('No personality with that id.')
      }
    }

    try {
      const settings = settingsStore.update({ assistantStyle: { activePersonalityId: id } })

      // Only for a phone. A renderer that made the change already knows, and
      // echoing it back would fight its own state mid-edit — the same rule
      // `conversations:changed` follows, for the same reason.
      if (isRemoteCall(event)) broadcastToWindows(IpcChannel.Settings.changed, settings)

      return stateOf()
    } catch (error) {
      log.error('Could not change the personality:', error)
      throw new Error('Could not change the personality.')
    }
  })
}

/** What a phone needs to draw the chooser, and nothing it does not. */
function stateOf(): RemotePersonalityState {
  const { assistantStyle } = settingsStore.get()
  return {
    active: assistantStyle.activePersonalityId,
    personalities: assistantStyle.personalities.map((personality) => ({
      id: personality.id,
      name: personality.name,
      // A personality the user made themselves need not have a one-liner. Empty
      // rather than absent, so the phone has one thing to check instead of two.
      role: personality.role ?? '',
      // Resolved here rather than on the phone: the desktop treats an absent tint
      // as the accent, and two places deciding that is two places to get it wrong.
      tint: personality.tint ?? 'accent'
    }))
  }
}
