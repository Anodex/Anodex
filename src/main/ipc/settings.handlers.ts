import { ipcMain, shell } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { AppSettings, DeepPartial } from '@shared/settings.types'
import { settingsStore } from '../settings/SettingsStore'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:settings')

/** IPC handlers for reading/updating settings and revealing the models folder. */
export function registerSettingsHandlers(): void {
  ipcMain.handle(IpcChannel.Settings.get, () => settingsStore.get())

  ipcMain.handle(IpcChannel.Settings.update, (_event, patch: DeepPartial<AppSettings>) => {
    try {
      return settingsStore.update(patch)
    } catch (error) {
      log.error('Failed to update settings:', error)
      throw new Error(error instanceof Error ? error.message : 'Could not update settings.')
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
