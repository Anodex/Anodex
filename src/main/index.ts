import { app, BrowserWindow } from 'electron'
import { createMainWindow } from './window'
import { closeToast } from './toastWindow'
import { closeHtmlPreviewWindows } from './htmlPreviewWindow'
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
import { pruneMissingModelPaths } from './llama/modelScanner'
import { schedulerStore } from './scheduler/SchedulerStore'
import { schedulerService } from './scheduler/SchedulerService'
import { setKeepAwake } from './scheduler/keepAwake'
import { emailAuthStore } from './email/EmailAuthStore'
import { emailAccountStore } from './email/EmailAccountStore'
import { skillStore } from './skills/SkillStore'
import { agentRunStore } from './agents/AgentRunStore'
import { agentRunService } from './agents/AgentRunService'
import { criticalThinkingStore } from './criticalThinking/CriticalThinkingStore'
import { criticalThinkingService } from './criticalThinking/CriticalThinkingService'
import { criticalThinkingEvidenceStore } from './criticalThinking/CriticalThinkingEvidenceStore'
import { mcpServerStore } from './mcp/McpServerStore'
import { mcpAuthStore } from './mcp/McpAuthStore'
import { mcpManager } from './mcp/McpManager'
import { createLogger } from './utils/logger'
import { diagnosticsReporter } from './diagnostics/DiagnosticsReporter'
import { registerCrashHandlers } from './diagnostics/crashHandlers'
import { finishModelLoad, getLoadRecovery, initLoadSentinel } from './llama/loadSentinel'
import { computerControlService } from './computerControl/ComputerControlService'

const log = createLogger('main')

/**
 * Surface a previous run's crashed model load in Diagnostics too, not only in
 * the recovery prompt. The prompt is answered once and gone; a bug report
 * filed a week later still needs the crash in the log.
 */
function reportInterruptedLoad(): void {
  const recovery = getLoadRecovery()
  if (!recovery) return
  const { interrupted } = recovery
  diagnosticsReporter.report({
    severity: 'error',
    category: 'model',
    message: recovery.headline,
    detail:
      `model: ${interrupted.modelPath}\n` +
      `gpuLayers: ${interrupted.gpuLayers}\n` +
      `contextSize: ${interrupted.contextSize ?? 'default'}\n` +
      `vision: ${interrupted.vision}\n` +
      `startedAt: ${interrupted.startedAt}`,
    suggestedFix: recovery.explanation,
    scope: 'model-load'
  })
}

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
  // Before anything else: an unhandled failure during startup itself is exactly
  // the kind that used to vanish. Entries are buffered in memory until a window
  // exists to receive them, so nothing raised here is lost.
  registerCrashHandlers()

  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  app
    .whenReady()
    .then(() => {
      // First, so every subsystem below logs into the file and the Diagnostics
      // page from its very first line.
      diagnosticsReporter.init()
      // Before any subsystem can load a model, so the record of a load that
      // never finished is read while it still means "the last run crashed".
      initLoadSentinel()
      reportInterruptedLoad()
      settingsStore.init()
      // Settings are loaded, and nothing has scanned yet — clear out model
      // files the user added that have since been deleted, so they stop
      // warning on every scan (see `pruneMissingModelPaths`).
      pruneMissingModelPaths()
      projectStore.init()
      projectMemoryStore.init()
      codeIndexStore.init()
      memoryStore.init()
      conversationStore.init()
      modelReliabilityStore.init()
      tokenActivityStore.init()
      updateService.init()
      emailAuthStore.init()
      // Settings have loaded by now, so any credential without a matching
      // account is an orphan — from an unlink that raced a crash, or a
      // settings file restored from elsewhere. Drop it rather than leaving a
      // live token on disk for a mailbox the app no longer shows.
      emailAccountStore.pruneCredentials()
      skillStore.init()
      agentRunStore.init()
      criticalThinkingStore.init()
      criticalThinkingEvidenceStore.init()
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
    computerControlService.stopAll('app-quit')
    abortAllChatGenerations()
    schedulerService.stop()
    agentRunService.stopAll()
    criticalThinkingService.stopAll()
    cancelAllDownloads()
    closeToast()
    closeHtmlPreviewWindows()
    // Quitting during a load is a clean exit, not a crash — drop the sentinel
    // so the next launch doesn't offer to recover from it.
    finishModelLoad()
    llamaService.unload().catch((error) => {
      log.error('Error unloading model on quit:', error)
    })
    // Local MCP servers spawn child processes — disconnect them so none are
    // orphaned after the app exits.
    mcpManager.disconnectAll().catch((error) => {
      log.error('Error disconnecting MCP servers on quit:', error)
    })
    // Last: flush whatever the shutdown above just logged to disk.
    diagnosticsReporter.shutdown()
  })
}
