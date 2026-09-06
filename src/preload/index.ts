import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IpcChannel, type AnodexApi, type ContextMenuRequest } from '@shared/ipc'
import type { EngineState, ModelDownloadProgress } from '@shared/model.types'
import type {
  ChatStreamChunk,
  ChatThinkingStreamChunk,
  HistoryCompactionEvent
} from '@shared/chat.types'
import type { ToolActivityEvent, ToolConfirmRequest } from '@shared/tools.types'
import type { UpdateStatus } from '@shared/update.types'
import type { ProviderUsageSnapshot } from '@shared/providerUsage.types'
import type { ScheduledTask } from '@shared/scheduledTask.types'
import type { AgentRun } from '@shared/agentRun.types'
import type {
  CriticalThinkingRun,
  CriticalThinkingStreamChunk
} from '@shared/criticalThinking.types'
import type { McpServerState } from '@shared/mcp.types'
import type { DiagnosticEntry } from '@shared/settings.types'
import type { ProjectsState } from '@shared/project.types'
import type { RemoteStatus } from '@shared/remote.types'

/**
 * The single, typed surface the renderer is allowed to touch. Exposed on
 * `window.anodex` via the context bridge — no `ipcRenderer`, no Node APIs, and
 * no channel strings leak into the renderer.
 */
const api: AnodexApi = {
  models: {
    list: () => ipcRenderer.invoke(IpcChannel.Models.list),
    add: () => ipcRenderer.invoke(IpcChannel.Models.add),
    addVisionProjector: (modelPath) =>
      ipcRenderer.invoke(IpcChannel.Models.addVisionProjector, modelPath),
    load: (options) => ipcRenderer.invoke(IpcChannel.Models.load, options),
    unload: () => ipcRenderer.invoke(IpcChannel.Models.unload),
    delete: (path) => ipcRenderer.invoke(IpcChannel.Models.delete, path),
    getState: () => ipcRenderer.invoke(IpcChannel.Models.getState),
    onStateChanged: (listener) => subscribe<EngineState>(IpcChannel.Models.stateChanged, listener),
    download: (model) => ipcRenderer.invoke(IpcChannel.Models.download, model),
    cancelDownload: (modelId) => ipcRenderer.invoke(IpcChannel.Models.cancelDownload, modelId),
    onDownloadProgress: (listener) =>
      subscribe<ModelDownloadProgress>(IpcChannel.Models.downloadProgress, listener),
    getReliability: () => ipcRenderer.invoke(IpcChannel.Models.getReliability),
    recommendSettingsForFile: (path) =>
      ipcRenderer.invoke(IpcChannel.Models.recommendSettings, path),
    discover: (query) => ipcRenderer.invoke(IpcChannel.Models.discover, query),
    fetchTopModels: () => ipcRenderer.invoke(IpcChannel.Models.fetchTopModels),
    getLoadRecovery: () => ipcRenderer.invoke(IpcChannel.Models.getLoadRecovery),
    dismissLoadRecovery: () => ipcRenderer.invoke(IpcChannel.Models.dismissLoadRecovery),
    dismissLoadRefusal: () => ipcRenderer.invoke(IpcChannel.Models.dismissLoadRefusal)
  },
  chat: {
    send: (request) => ipcRenderer.invoke(IpcChannel.Chat.send, request),
    stop: (conversationId) => ipcRenderer.invoke(IpcChannel.Chat.stop, conversationId),
    compact: (request) => ipcRenderer.invoke(IpcChannel.Chat.compact, request),
    onStream: (listener) => subscribe<ChatStreamChunk>(IpcChannel.Chat.stream, listener),
    onThinkingStream: (listener) =>
      subscribe<ChatThinkingStreamChunk>(IpcChannel.Chat.thinkingStream, listener),
    summarize: (text, maxWords) => ipcRenderer.invoke(IpcChannel.Chat.summarize, text, maxWords),
    title: (request) => ipcRenderer.invoke(IpcChannel.Chat.title, request),
    replaySuggestion: (request) => ipcRenderer.invoke(IpcChannel.Chat.replaySuggestion, request),
    onHistoryCompacted: (listener) =>
      subscribe<HistoryCompactionEvent>(IpcChannel.Chat.historyCompacted, listener)
  },
  provider: {
    verifyKey: (request) => ipcRenderer.invoke(IpcChannel.Provider.verifyKey, request),
    listModels: (provider) => ipcRenderer.invoke(IpcChannel.Provider.listModels, provider),
    getUsageSnapshot: () => ipcRenderer.invoke(IpcChannel.Provider.getUsageSnapshot),
    onUsageChanged: (listener) =>
      subscribe<ProviderUsageSnapshot>(IpcChannel.Provider.usageChanged, listener)
  },
  settings: {
    get: () => ipcRenderer.invoke(IpcChannel.Settings.get),
    update: (patch) => ipcRenderer.invoke(IpcChannel.Settings.update, patch),
    openModelsDir: () => ipcRenderer.invoke(IpcChannel.Settings.openModelsDir),
    pickPersonalityImage: () => ipcRenderer.invoke(IpcChannel.Settings.pickPersonalityImage),
    forgetPersonalityImage: (path) =>
      ipcRenderer.invoke(IpcChannel.Settings.forgetPersonalityImage, path)
  },
  tools: {
    pickWorkspace: () => ipcRenderer.invoke(IpcChannel.Tools.pickWorkspace),
    pickFolder: () => ipcRenderer.invoke(IpcChannel.Tools.pickFolder),
    respondConfirmation: (id, response) =>
      ipcRenderer.invoke(IpcChannel.Tools.confirmResponse, id, response),
    onActivity: (listener) => subscribe<ToolActivityEvent>(IpcChannel.Tools.activity, listener),
    onConfirmRequest: (listener) =>
      subscribe<ToolConfirmRequest>(IpcChannel.Tools.confirmRequest, listener),
    onConfirmCancelled: (listener) => subscribe<string>(IpcChannel.Tools.confirmCancelled, listener)
  },
  skills: {
    list: (projectId) => ipcRenderer.invoke(IpcChannel.Skills.list, projectId),
    read: (request) => ipcRenderer.invoke(IpcChannel.Skills.read, request),
    save: (request) => ipcRenderer.invoke(IpcChannel.Skills.save, request),
    delete: (request) => ipcRenderer.invoke(IpcChannel.Skills.delete, request)
  },
  changes: {
    list: (projectId) => ipcRenderer.invoke(IpcChannel.Changes.list, projectId)
  },
  checkpoints: {
    list: (projectId) => ipcRenderer.invoke(IpcChannel.Checkpoints.list, projectId),
    inspect: (request) => ipcRenderer.invoke(IpcChannel.Checkpoints.inspect, request),
    restore: (request) => ipcRenderer.invoke(IpcChannel.Checkpoints.restore, request),
    undo: (request) => ipcRenderer.invoke(IpcChannel.Checkpoints.undo, request),
    rollback: (request) => ipcRenderer.invoke(IpcChannel.Checkpoints.rollback, request)
  },
  system: {
    getInfo: () => ipcRenderer.invoke(IpcChannel.System.getInfo),
    getHardwareInfo: () => ipcRenderer.invoke(IpcChannel.System.getHardwareInfo),
    getPathForFile: (file) => webUtils.getPathForFile(file)
  },
  projects: {
    list: () => ipcRenderer.invoke(IpcChannel.Projects.list),
    listArchived: () => ipcRenderer.invoke(IpcChannel.Projects.listArchived),
    create: (request) => ipcRenderer.invoke(IpcChannel.Projects.create, request),
    update: (id, request) => ipcRenderer.invoke(IpcChannel.Projects.update, id, request),
    archive: (id) => ipcRenderer.invoke(IpcChannel.Projects.archive, id),
    restore: (id) => ipcRenderer.invoke(IpcChannel.Projects.restore, id),
    deletePermanent: (id) => ipcRenderer.invoke(IpcChannel.Projects.deletePermanent, id),
    setActive: (id) => ipcRenderer.invoke(IpcChannel.Projects.setActive, id),
    openFolder: (id) => ipcRenderer.invoke(IpcChannel.Projects.openFolder, id),
    onChanged: (listener) => subscribe<ProjectsState>(IpcChannel.Projects.changed, listener)
  },
  backup: {
    exportConversation: (conversation, format) =>
      ipcRenderer.invoke(IpcChannel.Backup.exportConversation, conversation, format),
    backupData: () => ipcRenderer.invoke(IpcChannel.Backup.backupData),
    revealPath: (path) => ipcRenderer.invoke(IpcChannel.Backup.revealPath, path)
  },
  conversations: {
    list: () => ipcRenderer.invoke(IpcChannel.Conversations.list),
    listSummaries: () => ipcRenderer.invoke(IpcChannel.Conversations.listSummaries),
    get: (conversationId, limit) =>
      ipcRenderer.invoke(IpcChannel.Conversations.get, conversationId, limit),
    listArchived: () => ipcRenderer.invoke(IpcChannel.Conversations.listArchived),
    save: (conversation) => ipcRenderer.invoke(IpcChannel.Conversations.save, conversation),
    delete: (id) => ipcRenderer.invoke(IpcChannel.Conversations.delete, id),
    restore: (id) => ipcRenderer.invoke(IpcChannel.Conversations.restore, id),
    deletePermanent: (id) => ipcRenderer.invoke(IpcChannel.Conversations.deletePermanent, id),
    deleteAll: () => ipcRenderer.invoke(IpcChannel.Conversations.deleteAll),
    deleteArchived: (ids) => ipcRenderer.invoke(IpcChannel.Conversations.deleteArchived, ids),
    getState: () => ipcRenderer.invoke(IpcChannel.Conversations.getState),
    setState: (state) => ipcRenderer.invoke(IpcChannel.Conversations.setState, state),
    readVisualPreview: (conversationId, assetId) =>
      ipcRenderer.invoke(IpcChannel.Conversations.readVisualPreview, conversationId, assetId),
    getVisualPreviewUsage: () => ipcRenderer.invoke(IpcChannel.Conversations.getVisualPreviewUsage),
    clearVisualPreviews: () => ipcRenderer.invoke(IpcChannel.Conversations.clearVisualPreviews),
    onChanged: (listener) => subscribe<string>(IpcChannel.Conversations.changed, listener)
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke(IpcChannel.Window.minimize),
    maximize: () => ipcRenderer.invoke(IpcChannel.Window.maximize),
    close: () => ipcRenderer.invoke(IpcChannel.Window.close),
    isMaximized: () => ipcRenderer.invoke(IpcChannel.Window.isMaximized),
    onMaximizedChanged: (listener) =>
      subscribe<boolean>(IpcChannel.Window.maximizedChanged, listener)
  },
  contextMenu: {
    onShow: (listener) => subscribe<ContextMenuRequest>(IpcChannel.ContextMenu.show, listener),
    runAction: (id) => ipcRenderer.invoke(IpcChannel.ContextMenu.runAction, id)
  },
  workspace: {
    listFiles: () => ipcRenderer.invoke(IpcChannel.Workspace.listFiles),
    getAbsolutePath: (relativePath) =>
      ipcRenderer.invoke(IpcChannel.Workspace.getAbsolutePath, relativePath),
    revealInFileExplorer: (relativePath) =>
      ipcRenderer.invoke(IpcChannel.Workspace.revealInFileExplorer, relativePath),
    openPath: (relativePath) => ipcRenderer.invoke(IpcChannel.Workspace.openPath, relativePath),
    deletePath: (relativePath) => ipcRenderer.invoke(IpcChannel.Workspace.deletePath, relativePath),
    readFileContent: (relativePath) =>
      ipcRenderer.invoke(IpcChannel.Workspace.readFileContent, relativePath),
    writeFileContent: (relativePath, content) =>
      ipcRenderer.invoke(IpcChannel.Workspace.writeFileContent, relativePath, content),
    prepareHtmlPreview: (relativePath, html) =>
      ipcRenderer.invoke(IpcChannel.Workspace.prepareHtmlPreview, relativePath, html),
    openHtmlPreviewWindow: (relativePath, title, html) =>
      ipcRenderer.invoke(IpcChannel.Workspace.openHtmlPreviewWindow, relativePath, title, html),
    refreshHtmlPreviewWindow: (relativePath, html) =>
      ipcRenderer.invoke(IpcChannel.Workspace.refreshHtmlPreviewWindow, relativePath, html)
  },
  computerControl: {
    start: (request) => ipcRenderer.invoke(IpcChannel.ComputerControl.start, request),
    pause: (conversationId) => ipcRenderer.invoke(IpcChannel.ComputerControl.pause, conversationId),
    resume: (conversationId) =>
      ipcRenderer.invoke(IpcChannel.ComputerControl.resume, conversationId),
    stop: (conversationId) => ipcRenderer.invoke(IpcChannel.ComputerControl.stop, conversationId),
    get: (conversationId) => ipcRenderer.invoke(IpcChannel.ComputerControl.get, conversationId),
    listDesktopTargets: () => ipcRenderer.invoke(IpcChannel.ComputerControl.listDesktopTargets),
    onChanged: (listener) => subscribe(IpcChannel.ComputerControl.changed, listener)
  },
  attachments: {
    readFile: (absolutePath) => ipcRenderer.invoke(IpcChannel.Attachments.readFile, absolutePath),
    pickFiles: () => ipcRenderer.invoke(IpcChannel.Attachments.pickFiles),
    pickImage: () => ipcRenderer.invoke(IpcChannel.Attachments.pickImage)
  },
  toast: {
    show: (content) => ipcRenderer.invoke(IpcChannel.Toast.show, content),
    focusMain: (conversationId) => ipcRenderer.invoke(IpcChannel.Toast.focusMain, conversationId),
    onOpenConversation: (listener) => subscribe<string>(IpcChannel.Toast.openConversation, listener)
  },
  updates: {
    getStatus: () => ipcRenderer.invoke(IpcChannel.Updates.getStatus),
    check: () => ipcRenderer.invoke(IpcChannel.Updates.check),
    download: () => ipcRenderer.invoke(IpcChannel.Updates.download),
    installAndRestart: () => ipcRenderer.invoke(IpcChannel.Updates.installAndRestart),
    onStatusChanged: (listener) =>
      subscribe<UpdateStatus>(IpcChannel.Updates.statusChanged, listener)
  },
  diagnostics: {
    list: () => ipcRenderer.invoke(IpcChannel.Diagnostics.list),
    onEntry: (listener) => subscribe<DiagnosticEntry>(IpcChannel.Diagnostics.entry, listener),
    getLogFile: () => ipcRenderer.invoke(IpcChannel.Diagnostics.getLogFile),
    revealLogFile: () => ipcRenderer.invoke(IpcChannel.Diagnostics.revealLogFile),
    getSupportBundlePreview: () =>
      ipcRenderer.invoke(IpcChannel.Diagnostics.getSupportBundlePreview),
    saveSupportBundle: () => ipcRenderer.invoke(IpcChannel.Diagnostics.saveSupportBundle)
  },
  stats: {
    getUsageProfile: () => ipcRenderer.invoke(IpcChannel.Stats.getUsageProfile),
    getUsageBreakdown: (range, granularity) =>
      ipcRenderer.invoke(IpcChannel.Stats.getUsageBreakdown, range, granularity)
  },
  memory: {
    list: (projectId) => ipcRenderer.invoke(IpcChannel.Memory.list, projectId),
    create: (request) => ipcRenderer.invoke(IpcChannel.Memory.create, request),
    update: (scope, id, patch) => ipcRenderer.invoke(IpcChannel.Memory.update, scope, id, patch),
    delete: (scope, id) => ipcRenderer.invoke(IpcChannel.Memory.delete, scope, id)
  },
  terminal: {
    create: () => ipcRenderer.invoke(IpcChannel.Terminal.create),
    write: (sessionId, data) => ipcRenderer.invoke(IpcChannel.Terminal.write, sessionId, data),
    resize: (sessionId, cols, rows) =>
      ipcRenderer.invoke(IpcChannel.Terminal.resize, sessionId, cols, rows),
    kill: (sessionId) => ipcRenderer.invoke(IpcChannel.Terminal.kill, sessionId),
    onData: (listener) =>
      subscribe<{ sessionId: string; data: string }>(IpcChannel.Terminal.data, listener),
    onExit: (listener) => subscribe<{ sessionId: string }>(IpcChannel.Terminal.exit, listener)
  },
  scheduler: {
    list: () => ipcRenderer.invoke(IpcChannel.Scheduler.list),
    create: (request) => ipcRenderer.invoke(IpcChannel.Scheduler.create, request),
    update: (id, request) => ipcRenderer.invoke(IpcChannel.Scheduler.update, id, request),
    delete: (id) => ipcRenderer.invoke(IpcChannel.Scheduler.delete, id),
    runNow: (id) => ipcRenderer.invoke(IpcChannel.Scheduler.runNow, id),
    getKeepAwake: () => ipcRenderer.invoke(IpcChannel.Scheduler.getKeepAwake),
    setKeepAwake: (value) => ipcRenderer.invoke(IpcChannel.Scheduler.setKeepAwake, value),
    onTasksChanged: (listener) =>
      subscribe<ScheduledTask[]>(IpcChannel.Scheduler.tasksChanged, listener)
  },
  agent: {
    list: () => ipcRenderer.invoke(IpcChannel.Agent.list),
    create: (request) => ipcRenderer.invoke(IpcChannel.Agent.create, request),
    stop: (id) => ipcRenderer.invoke(IpcChannel.Agent.stop, id),
    delete: (id) => ipcRenderer.invoke(IpcChannel.Agent.delete, id),
    approvePlan: (id) => ipcRenderer.invoke(IpcChannel.Agent.approvePlan, id),
    rejectPlan: (id) => ipcRenderer.invoke(IpcChannel.Agent.rejectPlan, id),
    onRunsChanged: (listener) => subscribe<AgentRun[]>(IpcChannel.Agent.runsChanged, listener)
  },
  criticalThinking: {
    list: () => ipcRenderer.invoke(IpcChannel.CriticalThinking.list),
    create: (request) => ipcRenderer.invoke(IpcChannel.CriticalThinking.create, request),
    approve: (id, request) => ipcRenderer.invoke(IpcChannel.CriticalThinking.approve, id, request),
    resume: (id) => ipcRenderer.invoke(IpcChannel.CriticalThinking.resume, id),
    stop: (id) => ipcRenderer.invoke(IpcChannel.CriticalThinking.stop, id),
    delete: (id) => ipcRenderer.invoke(IpcChannel.CriticalThinking.delete, id),
    exportPdf: (request) => ipcRenderer.invoke(IpcChannel.CriticalThinking.exportPdf, request),
    onStream: (listener) =>
      subscribe<CriticalThinkingStreamChunk>(IpcChannel.CriticalThinking.stream, listener),
    onRunsChanged: (listener) =>
      subscribe<CriticalThinkingRun[]>(IpcChannel.CriticalThinking.runsChanged, listener)
  },
  email: {
    getStatus: () => ipcRenderer.invoke(IpcChannel.Email.getStatus),
    openWebmail: (accountId) => ipcRenderer.invoke(IpcChannel.Email.openWebmail, accountId),
    discover: (address) => ipcRenderer.invoke(IpcChannel.Email.discover, address),
    connectOAuth: (request) => ipcRenderer.invoke(IpcChannel.Email.connectOAuth, request),
    connectPassword: (request) => ipcRenderer.invoke(IpcChannel.Email.connectPassword, request),
    removeAccount: (accountId) => ipcRenderer.invoke(IpcChannel.Email.removeAccount, accountId),
    setPrimaryAccount: (accountId) =>
      ipcRenderer.invoke(IpcChannel.Email.setPrimaryAccount, accountId),
    setSyncMode: (accountId, syncMode) =>
      ipcRenderer.invoke(IpcChannel.Email.setSyncMode, accountId, syncMode),
    listAccounts: () => ipcRenderer.invoke(IpcChannel.Email.listAccounts),
    getUnreadThreadCount: (accountId) =>
      ipcRenderer.invoke(IpcChannel.Email.getUnreadThreadCount, accountId),
    listThreads: (request = {}) => ipcRenderer.invoke(IpcChannel.Email.listThreads, request),
    search: (request) => ipcRenderer.invoke(IpcChannel.Email.search, request),
    readMessage: (id, accountId) => ipcRenderer.invoke(IpcChannel.Email.readMessage, id, accountId),
    getThreadMessages: (threadId, accountId) =>
      ipcRenderer.invoke(IpcChannel.Email.getThreadMessages, threadId, accountId),
    digestThreads: (requests) => ipcRenderer.invoke(IpcChannel.Email.digestThreads, requests),
    applyFlag: (request) => ipcRenderer.invoke(IpcChannel.Email.applyFlag, request),
    move: (request) => ipcRenderer.invoke(IpcChannel.Email.move, request),
    listMailboxes: (accountId) => ipcRenderer.invoke(IpcChannel.Email.listMailboxes, accountId),
    saveAttachment: (request) => ipcRenderer.invoke(IpcChannel.Email.saveAttachment, request),
    loadRemoteImages: (urls) => ipcRenderer.invoke(IpcChannel.Email.loadRemoteImages, urls),
    createDraft: (request) => ipcRenderer.invoke(IpcChannel.Email.createDraft, request),
    send: (request) => ipcRenderer.invoke(IpcChannel.Email.send, request)
  },
  github: {
    getState: (projectId) => ipcRenderer.invoke(IpcChannel.Github.getState, projectId),
    connect: (request, projectId) =>
      ipcRenderer.invoke(IpcChannel.Github.connect, request, projectId),
    disconnect: (projectId) => ipcRenderer.invoke(IpcChannel.Github.disconnect, projectId),
    detectRepository: (projectId) =>
      ipcRenderer.invoke(IpcChannel.Github.detectRepository, projectId)
  },
  git: {
    getStatus: (projectId) => ipcRenderer.invoke(IpcChannel.Git.getStatus, projectId),
    init: (projectId) => ipcRenderer.invoke(IpcChannel.Git.init, projectId),
    createBranch: (projectId, name) =>
      ipcRenderer.invoke(IpcChannel.Git.createBranch, projectId, name),
    listBranches: (projectId) => ipcRenderer.invoke(IpcChannel.Git.listBranches, projectId),
    switchBranch: (projectId, name) =>
      ipcRenderer.invoke(IpcChannel.Git.switchBranch, projectId, name),
    commit: (projectId, message) => ipcRenderer.invoke(IpcChannel.Git.commit, projectId, message),
    push: (projectId) => ipcRenderer.invoke(IpcChannel.Git.push, projectId)
  },
  remote: {
    status: () => ipcRenderer.invoke(IpcChannel.Remote.status),
    setEnabled: (enabled) => ipcRenderer.invoke(IpcChannel.Remote.setEnabled, enabled),
    beginPairing: () => ipcRenderer.invoke(IpcChannel.Remote.beginPairing),
    cancelPairing: () => ipcRenderer.invoke(IpcChannel.Remote.cancelPairing),
    revoke: () => ipcRenderer.invoke(IpcChannel.Remote.revoke),
    setInternetAccess: (enabled) =>
      ipcRenderer.invoke(IpcChannel.Remote.setInternetAccess, enabled),
    setManualAddress: (address, port) =>
      ipcRenderer.invoke(IpcChannel.Remote.setManualAddress, address, port),
    setPort: (port) => ipcRenderer.invoke(IpcChannel.Remote.setPort, port),
    onStatusChanged: (listener) =>
      subscribe<RemoteStatus>(IpcChannel.Remote.statusChanged, listener)
  },
  mcp: {
    list: () => ipcRenderer.invoke(IpcChannel.Mcp.list),
    add: (config, credentials) => ipcRenderer.invoke(IpcChannel.Mcp.add, config, credentials),
    update: (id, patch, credentials) =>
      ipcRenderer.invoke(IpcChannel.Mcp.update, id, patch, credentials),
    remove: (id) => ipcRenderer.invoke(IpcChannel.Mcp.remove, id),
    setEnabled: (id, enabled) => ipcRenderer.invoke(IpcChannel.Mcp.setEnabled, id, enabled),
    setStaticToken: (id, token) => ipcRenderer.invoke(IpcChannel.Mcp.setStaticToken, id, token),
    connect: (id) => ipcRenderer.invoke(IpcChannel.Mcp.connect, id),
    testConnection: (config) => ipcRenderer.invoke(IpcChannel.Mcp.testConnection, config),
    disconnectAuth: (id) => ipcRenderer.invoke(IpcChannel.Mcp.disconnectAuth, id),
    getStatuses: () => ipcRenderer.invoke(IpcChannel.Mcp.getStatuses),
    listTools: () => ipcRenderer.invoke(IpcChannel.Mcp.listTools),
    onStatusChanged: (listener) => subscribe<McpServerState>(IpcChannel.Mcp.statusChanged, listener)
  }
}

/** Subscribe to a main→renderer channel; returns an unsubscribe function. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('anodex', api)
