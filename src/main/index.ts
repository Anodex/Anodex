import { app, BrowserWindow } from 'electron'
import { createMainWindow } from './window'
import { closeToast } from './toastWindow'
import { registerIpcHandlers } from './ipc'
import { abortAllChatGenerations } from './ipc/chat.handlers'
import { settingsStore } from './settings/SettingsStore'
import { projectStore } from './projects/ProjectStore'
import { projectMemoryStore } from './projects/ProjectMemoryStore'
import { codeIndexStore } from './codeIndex/CodeIndexStore'
import { memoryStore } from './memory/MemoryStore'
import { conversationStore } from './conversations/ConversationStore'
import { modelReliabilityStore } from './models/ModelReliabilityStore'
import { tokenActivityStore } from './stats/TokenActivityStore'
import { updateService } from './updates/UpdateService'
import { llamaService } from './llama/LlamaService'
import { cancelAllDownloads } from './llama/modelDownloader'
import { schedulerStore } from './scheduler/SchedulerStore'
import { schedulerService } from './scheduler/SchedulerService'
import { setKeepAwake } from './scheduler/keepAwake'
import { emailAuthStore } from './email/EmailAuthStore'
import { skillStore } from './skills/SkillStore'
import { agentRunStore } from './agents/AgentRunStore'
import { agentRunService } from './agents/AgentRunService'
import { criticalThinkingStore } from './criticalThinking/CriticalThinkingStore'
import { criticalThinkingService } from './criticalThinking/CriticalThinkingService'
import { mcpServerStore } from './mcp/McpServerStore'
import { mcpAuthStore } from './mcp/McpAuthStore'
import { mcpManager } from './mcp/McpManager'
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
      codeIndexStore.init()
      memoryStore.init()
      conversationStore.init()
      modelReliabilityStore.init()
      tokenActivityStore.init()
      updateService.init()
      emailAuthStore.init()
      skillStore.init()
      agentRunStore.init()
      criticalThinkingStore.init()
      schedulerStore.init()
      schedulerService.init()
      setKeepAwake(settingsStore.get().scheduler.keepAwake)
      mcpServerStore.init()
      mcpAuthStore.init()
      // Connects enabled servers in the background — never blocks startup on
      // a slow or dead MCP server (see McpManager.init's doc comment).
      mcpManager.init()
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

  // Release GPU/model resources and stop background work before the process
  // exits — otherwise a loaded model, an in-flight download, or a running
  // generation is just killed mid-operation instead of shut down cleanly.
  app.on('will-quit', () => {
    abortAllChatGenerations()
    schedulerService.stop()
    agentRunService.stopAll()
    criticalThinkingService.stopAll()
    cancelAllDownloads()
    closeToast()
    llamaService.unload().catch((error) => {
      log.error('Error unloading model on quit:', error)
    })
    // Local MCP servers spawn child processes — disconnect them so none are
    // orphaned after the app exits.
    mcpManager.disconnectAll().catch((error) => {
      log.error('Error disconnecting MCP servers on quit:', error)
    })
  })
}
