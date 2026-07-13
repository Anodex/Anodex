import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IpcChannel, type AnodexApi, type ContextMenuRequest } from '@shared/ipc'
import type { EngineState, ModelDownloadProgress } from '@shared/model.types'
import type { ChatStreamChunk, HistoryCompactionEvent } from '@shared/chat.types'
import type { ToolActivityEvent, ToolConfirmRequest } from '@shared/tools.types'
import type { UpdateStatus } from '@shared/update.types'
import type { ProviderUsageSnapshot } from '@shared/providerUsage.types'
import type { ScheduledTask } from '@shared/scheduledTask.types'
import type { AgentRun } from '@shared/agentRun.types'

/**
 * The single, typed surface the renderer is allowed to touch. Exposed on
 * `window.anodex` via the context bridge — no `ipcRenderer`, no Node APIs, and
 * no channel strings leak into the renderer.
 */
const api: AnodexApi = {
  models: {
    list: () => ipcRenderer.invoke(IpcChannel.Models.list),
    add: () => ipcRenderer.invoke(IpcChannel.Models.add),
    load: (options) => ipcRenderer.invoke(IpcChannel.Models.load, options),
    unload: () => ipcRenderer.invoke(IpcChannel.Models.unload),
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
    fetchTopModels: () => ipcRenderer.invoke(IpcChannel.Models.fetchTopModels)
  },
  chat: {
    send: (request) => ipcRenderer.invoke(IpcChannel.Chat.send, request),
    stop: (conversationId) => ipcRenderer.invoke(IpcChannel.Chat.stop, conversationId),
    compact: (request) => ipcRenderer.invoke(IpcChannel.Chat.compact, request),
    onStream: (listener) => subscribe<ChatStreamChunk>(IpcChannel.Chat.stream, listener),
    summarize: (text, maxWords) => ipcRenderer.invoke(IpcChannel.Chat.summarize, text, maxWords),
    title: (request) => ipcRenderer.invoke(IpcChannel.Chat.title, request),
    onHistoryCompacted: (listener) =>
      subscribe<HistoryCompactionEvent>(IpcChannel.Chat.historyCompacted, listener)
  },
  provider: {
    verifyKey: (request) => ipcRenderer.invoke(IpcChannel.Provider.verifyKey, request),
    getUsageSnapshot: () => ipcRenderer.invoke(IpcChannel.Provider.getUsageSnapshot),
    onUsageChanged: (listener) =>
      subscribe<ProviderUsageSnapshot>(IpcChannel.Provider.usageChanged, listener)
  },
  settings: {
    get: () => ipcRenderer.invoke(IpcChannel.Settings.get),
    update: (patch) => ipcRenderer.invoke(IpcChannel.Settings.update, patch),
    openModelsDir: () => ipcRenderer.invoke(IpcChannel.Settings.openModelsDir)
  },
  tools: {
    pickWorkspace: () => ipcRenderer.invoke(IpcChannel.Tools.pickWorkspace),
    pickFolder: () => ipcRenderer.invoke(IpcChannel.Tools.pickFolder),
    respondConfirmation: (id, response) =>
      ipcRenderer.invoke(IpcChannel.Tools.confirmResponse, id, response),
    onActivity: (listener) => subscribe<ToolActivityEvent>(IpcChannel.Tools.activity, listener),
    onConfirmRequest: (listener) =>
      subscribe<ToolConfirmRequest>(IpcChannel.Tools.confirmRequest, listener)
  },
  skills: {
    list: (projectId) => ipcRenderer.invoke(IpcChannel.Skills.list, projectId),
    read: (request) => ipcRenderer.invoke(IpcChannel.Skills.read, request),
    save: (request) => ipcRenderer.invoke(IpcChannel.Skills.save, request),
    delete: (request) => ipcRenderer.invoke(IpcChannel.Skills.delete, request)
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
    delete: (id) => ipcRenderer.invoke(IpcChannel.Projects.delete, id),
    restore: (id) => ipcRenderer.invoke(IpcChannel.Projects.restore, id),
    deletePermanent: (id) => ipcRenderer.invoke(IpcChannel.Projects.deletePermanent, id),
    setActive: (id) => ipcRenderer.invoke(IpcChannel.Projects.setActive, id),
    openFolder: (id) => ipcRenderer.invoke(IpcChannel.Projects.openFolder, id)
  },
  conversations: {
    list: () => ipcRenderer.invoke(IpcChannel.Conversations.list),
    listArchived: () => ipcRenderer.invoke(IpcChannel.Conversations.listArchived),
    save: (conversation) => ipcRenderer.invoke(IpcChannel.Conversations.save, conversation),
    delete: (id) => ipcRenderer.invoke(IpcChannel.Conversations.delete, id),
    restore: (id) => ipcRenderer.invoke(IpcChannel.Conversations.restore, id),
    deletePermanent: (id) => ipcRenderer.invoke(IpcChannel.Conversations.deletePermanent, id),
    deleteAll: () => ipcRenderer.invoke(IpcChannel.Conversations.deleteAll),
    deleteArchived: (ids) => ipcRenderer.invoke(IpcChannel.Conversations.deleteArchived, ids),
    getState: () => ipcRenderer.invoke(IpcChannel.Conversations.getState),
    setState: (state) => ipcRenderer.invoke(IpcChannel.Conversations.setState, state)
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
      ipcRenderer.invoke(IpcChannel.Workspace.writeFileContent, relativePath, content)
  },
  attachments: {
    readFile: (absolutePath) => ipcRenderer.invoke(IpcChannel.Attachments.readFile, absolutePath),
    pickFiles: () => ipcRenderer.invoke(IpcChannel.Attachments.pickFiles)
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
  email: {
    getStatus: () => ipcRenderer.invoke(IpcChannel.Email.getStatus),
    openGmailWeb: () => ipcRenderer.invoke(IpcChannel.Email.openGmailWeb),
    connectGmail: () => ipcRenderer.invoke(IpcChannel.Email.connectGmail),
    disconnectGmail: () => ipcRenderer.invoke(IpcChannel.Email.disconnectGmail),
    listThreads: (request = {}) => ipcRenderer.invoke(IpcChannel.Email.listThreads, request),
    search: (request) => ipcRenderer.invoke(IpcChannel.Email.search, request),
    readMessage: (id) => ipcRenderer.invoke(IpcChannel.Email.readMessage, id),
    createDraft: (request) => ipcRenderer.invoke(IpcChannel.Email.createDraft, request),
    send: (request) => ipcRenderer.invoke(IpcChannel.Email.send, request)
  }
}

/** Subscribe to a main→renderer channel; returns an unsubscribe function. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('anodex', api)
