import { BrowserWindow, ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { err, ok, type Result } from '@shared/result'
import { SpeechService } from './SpeechService'
import { createLogger } from '../utils/logger'
import { settingsStore } from '../settings/SettingsStore'

const log = createLogger('speech')
export const speechService = new SpeechService()
let download: Promise<void> | null = null

function errorResult<T>(code: string, message: string, error: unknown): Result<T> {
  const detail = error instanceof Error ? error.message : String(error)
  log.error(message, detail)
  return err(code, message, detail)
}

export function registerSpeechHandlers(): void {
  ipcMain.handle(IpcChannel.Speech.status, () => speechService.status())
  ipcMain.handle(IpcChannel.Speech.getTranscript, () => speechService.getTranscript())
  ipcMain.handle(
    IpcChannel.Speech.setTranscript,
    async (_event, text: unknown): Promise<Result<void>> => {
      if (typeof text !== 'string')
        return err('speech.invalid-transcript', 'The transcript was invalid.')
      try {
        await speechService.setTranscript(text)
        return ok(undefined)
      } catch (error) {
        return errorResult(
          'speech.transcript-failed',
          'Could not save the recording transcript.',
          error
        )
      }
    }
  )
  ipcMain.handle(IpcChannel.Speech.prepare, async (): Promise<Result<void>> => {
    try {
      await speechService.prepare()
      return ok(undefined)
    } catch (error) {
      return errorResult('speech.prepare-failed', 'Could not prepare speech.', error)
    }
  })
  ipcMain.handle(IpcChannel.Speech.release, async () => speechService.shutdown())
  ipcMain.handle(IpcChannel.Speech.cancelDownload, () => speechService.cancelModelDownload())
  ipcMain.handle(IpcChannel.Speech.removeReference, async () => speechService.removeReference())
  ipcMain.handle(IpcChannel.Speech.download, async (): Promise<Result<void>> => {
    if (!download) {
      let lastProgressAt = 0
      download = speechService
        .downloadModels((receivedBytes, totalBytes) => {
          const now = Date.now()
          if (receivedBytes < totalBytes && now - lastProgressAt < 100) return
          lastProgressAt = now
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) {
              window.webContents.send(IpcChannel.Speech.progress, { receivedBytes, totalBytes })
            }
          }
        })
        .finally(() => {
          download = null
        })
    }
    try {
      await download
      return ok(undefined)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return err('speech.download-cancelled', 'The download was cancelled.')
      }
      return errorResult(
        'speech.download-failed',
        'Could not download the local speech model.',
        error
      )
    }
  })
  ipcMain.handle(IpcChannel.Speech.chooseReference, async (): Promise<Result<boolean>> => {
    try {
      await speechService.chooseReference()
      return ok(true)
    } catch (error) {
      if (error instanceof Error && error.message === 'No recording was selected.') return ok(false)
      return errorResult('speech.reference-failed', 'Could not use that voice recording.', error)
    }
  })
  ipcMain.handle(IpcChannel.Speech.speak, async (event, requestId: unknown, text: unknown) => {
    if (typeof requestId !== 'string' || typeof text !== 'string') {
      return err('speech.invalid-request', 'The speech request was invalid.')
    }
    if (!settingsStore.get().speech.enabled)
      return err('speech.disabled', 'Enable read aloud in Settings first.')
    try {
      await speechService.speak(requestId, text, (id, pcm) => {
        if (!event.sender.isDestroyed())
          event.sender.send(IpcChannel.Speech.audio, { requestId: id, pcm })
      })
      return ok(undefined)
    } catch (error) {
      return errorResult(
        'speech.synthesis-failed',
        'Anodex could not read this reply aloud.',
        error
      )
    }
  })
  ipcMain.handle(IpcChannel.Speech.stop, () => speechService.stop())
}
