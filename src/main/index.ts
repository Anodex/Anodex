import { app, BrowserWindow } from 'electron'
import { createMainWindow } from './window'
import { registerIpcHandlers } from './ipc'
import { settingsStore } from './settings/SettingsStore'
import { projectStore } from './projects/ProjectStore'
import { projectMemoryStore } from './projects/ProjectMemoryStore'
import { conversationStore } from './conversations/ConversationStore'
import { modelReliabilityStore } from './models/ModelReliabilityStore'
import { updateService } from './updates/UpdateService'
import { createLogger } from './utils/logger'

const log = createLogger('main')

/** Give startup (model auto-load, window paint) a moment before an update
 *  check adds its own network activity — same reasoning as the model
 *  auto-load delay, just for a much lighter request. */
const STARTUP_UPDATE_CHECK_DELAY_MS = 5000

// Windows derives taskbar grouping/jump-list identity from this — without it
// (notably in an unpackaged dev run, which has no Start Menu shortcut to
// carry the id), Windows falls back to showing the raw process name
// ("electron.app.Electron"). Matches the `appId` in `electron-builder.yml`.
if (process.platform === 'win32') app.setAppUserModelId('com.anodex.app')

// Enforce a single running instance; focus the existing window on relaunch.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  app
    .whenReady()
    .then(() => {
      settingsStore.init()
      projectStore.init()
      projectMemoryStore.init()
      conversationStore.init()
      modelReliabilityStore.init()
      updateService.init()
      registerIpcHandlers()
      createMainWindow()
      setTimeout(() => void updateService.check(), STARTUP_UPDATE_CHECK_DELAY_MS)

      // macOS: re-create a window when the dock icon is clicked with none open.
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
      })
    })
    .catch((error) => {
      log.error('Fatal error during startup:', error)
      app.quit()
    })

  app.on('window-all-closed', () => {
    // On macOS apps typically stay active until explicitly quit.
    if (process.platform !== 'darwin') app.quit()
  })
}
