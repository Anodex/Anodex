import { ipcMain, nativeImage } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { allChatPersonalities } from '@shared/chatPersonality'
import type { RemotePersonalityImage, RemotePersonalityState } from '@shared/personality.types'
import { broadcastToWindows } from '../broadcast'
import { isRemoteCall } from '../clients/clientRegistry'
import { settingsStore } from '../settings/SettingsStore'
import { personalityImagesDir } from '../settings/personalityImages'
import {
  REMOTE_PERSONALITY_PICTURE_EDGE,
  isStoredPersonalityPicture,
  personalityPictureKey
} from '../settings/personalityPictureAccess'
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
      const known = allChatPersonalities(settingsStore.get().assistantStyle.personalities)
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

  ipcMain.handle(IpcChannel.Personality.image, (_event, id: string) => pictureOf(id))
}

/**
 * A user personality's picture, as a thumbnail a phone can draw.
 *
 * The phone showed initials for every personality somebody had given a face,
 * because all it had was `image` — a path on this machine's disk. The picture is
 * fetched per personality and only when the phone lacks it, rather than inlined in
 * `personality:list`, which is read on every connect.
 *
 * Null for anything that is not a picture this app copied in: no picture, an
 * unknown id, a file that has since gone, or a path outside the store.
 */
function pictureOf(id: string): RemotePersonalityImage | null {
  const personality = allChatPersonalities(settingsStore.get().assistantStyle.personalities).find(
    (candidate) => candidate.id === id
  )
  const path = personality?.image
  if (!path || !isStoredPersonalityPicture(path, personalityImagesDir())) return null

  const picture = nativeImage.createFromPath(path)
  if (picture.isEmpty()) return null

  const { width, height } = picture.getSize()
  const scale = Math.min(1, REMOTE_PERSONALITY_PICTURE_EDGE / Math.max(width, height))
  const thumbnail =
    scale < 1
      ? picture.resize({
          width: Math.round(width * scale),
          height: Math.round(height * scale),
          quality: 'good'
        })
      : picture

  return { mimeType: 'image/png', base64: thumbnail.toPNG().toString('base64') }
}

/**
 * What a phone needs to draw the chooser, and nothing it does not.
 *
 * `allChatPersonalities`, not `assistantStyle.personalities`. That field holds only
 * the user's *own* entries and is empty on a fresh install — the shipped ones live
 * in code. Reading it directly is why the phone's picker was empty on every machine
 * where nobody had written a personality by hand, and why selecting the default
 * would have been refused as an unknown id: it is `builtin:anodex`, which that list
 * has never contained.
 */
function stateOf(): RemotePersonalityState {
  const { assistantStyle } = settingsStore.get()
  return {
    active: assistantStyle.activePersonalityId,
    personalities: allChatPersonalities(assistantStyle.personalities).map((personality) => ({
      id: personality.id,
      name: personality.name,
      // A personality the user made themselves need not have a one-liner. Empty
      // rather than absent, so the phone has one thing to check instead of two.
      role: personality.role ?? '',
      // Resolved here rather than on the phone: the desktop treats an absent tint
      // as the accent, and two places deciding that is two places to get it wrong.
      tint: personality.tint ?? 'accent',
      image: personalityPictureKey(personality.image)
    }))
  }
}
