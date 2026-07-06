import { ipcMain, shell } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { AppSettings, DeepPartial } from '@shared/settings.types'
import { settingsStore } from '../settings/SettingsStore'

/** IPC handlers for reading/updating settings and revealing the models folder. */
export function registerSettingsHandlers(): void {
  ipcMain.handle(IpcChannel.Settings.get, () => settingsStore.get())

  ipcMain.handle(IpcChannel.Settings.update, (_event, patch: DeepPartial<AppSettings>) =>
    settingsStore.update(patch)
  )

  ipcMain.handle(IpcChannel.Settings.openModelsDir, async () => {
    await shell.openPath(settingsStore.get().modelsDirectory)
  })
}
