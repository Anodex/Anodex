import { BrowserWindow, ipcMain } from 'electron'
import { IpcChannel } from '../../shared/ipc'
import { err, ok, type Result } from '../../shared/result'
import { createLogger } from '../utils/logger'
import {
  silencePcm,
  speak,
  speechAvailable,
  voiceModelReady,
  wavHeader,
  type SpokenChunk
} from './Speaker'
import { voiceEnabled } from './voiceCapability'
import {
  cancelVoiceModelDownload,
  downloadVoiceModel,
  removeVoiceModel,
  VOICE_MODEL_BYTES,
  voiceModelBytesPresent,
  voiceModelDownloading
} from './voiceModel'

const log = createLogger('voice')

/**
 * Reading a reply aloud, from the renderer's point of view.
 *
 * One call in, one wav back. Deliberately not a stream of chunks, and that is a
 * decision rather than laziness: generating is slower than playing — about 2.1
 * seconds of process start per sentence — so audio handed over as it arrived
 * would stutter, and a voice that stutters sounds broken in a way that a voice
 * which takes a moment to begin does not. Progress is reported instead, so the
 * wait is visible and cancellable.
 */

/** One reply at a time. A second request replaces the first rather than queueing. */
let current: { id: string; cancelled: boolean } | null = null

/**
 * Whether this window may offer to read anything.
 *
 * Both halves, and the first one is the half that was missing: `enabled` was
 * reported to the renderer and then never consulted, so the switch that is
 * supposed to turn voice off turned off only the phone bridge, and a machine
 * that happened to hold the model got the button anyway. The rule was written
 * in `voiceCapability` and quietly disagreed with here — which is the whole
 * failure mode a flag is meant to prevent.
 */
function canSpeak(): boolean {
  return voiceEnabled() && speechAvailable()
}

export function registerVoiceHandlers(): void {
  ipcMain.handle(IpcChannel.Voice.available, () => ({
    // Three separate things, and a caller that is told "no" deserves to know
    // which: the feature is off, the model has not been fetched, or the runtime
    // is missing from this build.
    enabled: voiceEnabled(),
    modelReady: voiceModelReady(),
    ready: canSpeak(),
    modelBytes: VOICE_MODEL_BYTES,
    modelBytesPresent: voiceModelBytesPresent(),
    downloading: voiceModelDownloading()
  }))

  ipcMain.handle(IpcChannel.Voice.download, async (): Promise<Result<void>> => {
    try {
      await downloadVoiceModel((progress) => {
        // Broadcast, unlike speaking progress: a 2.3 GB download belongs to the
        // machine rather than to the window that happened to start it, and a
        // second window showing a stalled bar for a download that is running
        // fine is a bug report waiting to happen.
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) {
            window.webContents.send(IpcChannel.Voice.downloadProgress, progress)
          }
        }
      })
      return ok(undefined)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The download failed'
      // Cancelling is not failing. `downloadFile` aborts through an
      // AbortController, which surfaces as an error either way, and reporting
      // "download failed" to somebody who just pressed Cancel is the app
      // telling them their own decision went wrong.
      if (error instanceof Error && error.name === 'AbortError') {
        log.info('the download was cancelled')
        return err('voice.download-cancelled', 'The download was cancelled')
      }
      log.error('the voice could not be fetched:', message)
      return err('voice.download-failed', message)
    }
  })

  ipcMain.handle(IpcChannel.Voice.cancelDownload, () => {
    cancelVoiceModelDownload()
    return true
  })

  ipcMain.handle(IpcChannel.Voice.removeModel, async (): Promise<Result<void>> => {
    if (voiceModelDownloading()) {
      return err('voice.busy', 'The voice is downloading — cancel that first')
    }
    try {
      await removeVoiceModel()
      return ok(undefined)
    } catch (error) {
      return err(
        'voice.remove-failed',
        error instanceof Error ? error.message : 'The voice could not be removed'
      )
    }
  })

  ipcMain.handle(IpcChannel.Voice.speak, async (event, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) return null
    if (!canSpeak()) return null

    const id = `${Date.now()}`
    current = { id, cancelled: false }
    const mine = current

    const chunks = await speak(text, {
      cancelled: () => mine.cancelled,
      onChunk: (_chunk: SpokenChunk, index: number, total: number) => {
        // Sent to the window that asked, not broadcast: two windows reading two
        // different replies should not share a progress bar.
        if (!event.sender.isDestroyed()) {
          event.sender.send(IpcChannel.Voice.progress, { id, index: index + 1, total })
        }
      }
    })

    if (mine.cancelled || chunks.length === 0) return null

    const parts: Buffer[] = []
    chunks.forEach((chunk, index) => {
      parts.push(chunk.pcm)
      if (index < chunks.length - 1 && chunk.pauseAfterMs > 0) {
        parts.push(silencePcm(chunk.pauseAfterMs))
      }
    })
    const data = Buffer.concat(parts)
    log.info(`read ${(data.length / 2 / 24_000).toFixed(1)}s aloud`)
    return Buffer.concat([wavHeader(data.length), data])
  })

  ipcMain.handle(IpcChannel.Voice.stop, () => {
    // Stops after the sentence being made, not during: a half-generated sentence
    // is wasted either way, and killing mid-word orphans the model's process.
    if (current) current.cancelled = true
    return true
  })
}
