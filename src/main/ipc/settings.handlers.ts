import { ipcMain, shell } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { SettingsPatch } from '@shared/settings.types'
import { settingsStore } from '../settings/SettingsStore'
import { forgetPersonalityImage, pickPersonalityImage } from '../settings/personalityImages'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:settings')

/** IPC handlers for reading/updating settings and revealing the models folder. */
export function registerSettingsHandlers(): void {
  ipcMain.handle(IpcChannel.Settings.get, () => settingsStore.get())

  ipcMain.handle(IpcChannel.Settings.update, (_event, patch: SettingsPatch) => {
    try {
      return settingsStore.update(patch)
    } catch (error) {
      log.error('Failed to update settings:', error)
      throw new Error(error instanceof Error ? error.message : 'Could not update settings.')
    }
  })

  // Cancelling returns null, which is not an error: the renderer keeps the
  // picture the personality already had.
  ipcMain.handle(IpcChannel.Settings.pickPersonalityImage, async () => {
    try {
      return await pickPersonalityImage()
    } catch (error) {
      log.error('Failed to import a personality picture:', error)
      throw new Error(error instanceof Error ? error.message : 'Could not import that picture.')
    }
  })

  ipcMain.handle(IpcChannel.Settings.forgetPersonalityImage, async (_event, path: string) => {
    try {
      await forgetPersonalityImage(path)
    } catch (error) {
      log.error('Failed to remove a personality picture:', error)
    }
  })

  ipcMain.handle(IpcChannel.Settings.openModelsDir, async () => {
    try {
      await shell.openPath(settingsStore.get().modelsDirectory)
    } catch (error) {
      log.error('Failed to open models directory:', error)
    }
  })
}
