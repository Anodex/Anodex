import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IpcChannel, type AnodexApi } from '@shared/ipc'
import type { EngineState, ModelDownloadProgress } from '@shared/model.types'
import type { ChatStreamChunk, HistoryCompactionEvent } from '@shared/chat.types'
import type { ToolActivityEvent, ToolConfirmRequest } from '@shared/tools.types'
import type { UpdateStatus } from '@shared/update.types'

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
    onStream: (listener) => subscribe<ChatStreamChunk>(IpcChannel.Chat.stream, listener),
    summarize: (text, maxWords) => ipcRenderer.invoke(IpcChannel.Chat.summarize, text, maxWords),
    onHistoryCompacted: (listener) =>
      subscribe<HistoryCompactionEvent>(IpcChannel.Chat.historyCompacted, listener)
  },
  settings: {
    get: () => ipcRenderer.invoke(IpcChannel.Settings.get),
    update: (patch) => ipcRenderer.invoke(IpcChannel.Settings.update, patch),
    openModelsDir: () => ipcRenderer.invoke(IpcChannel.Settings.openModelsDir)
  },
  tools: {
    pickWorkspace: () => ipcRenderer.invoke(IpcChannel.Tools.pickWorkspace),
    respondConfirmation: (id, response) =>
      ipcRenderer.invoke(IpcChannel.Tools.confirmResponse, id, response),
    onActivity: (listener) => subscribe<ToolActivityEvent>(IpcChannel.Tools.activity, listener),
    onConfirmRequest: (listener) =>
      subscribe<ToolConfirmRequest>(IpcChannel.Tools.confirmRequest, listener)
  },
  system: {
    getInfo: () => ipcRenderer.invoke(IpcChannel.System.getInfo),
    getHardwareInfo: () => ipcRenderer.invoke(IpcChannel.System.getHardwareInfo),
    getPathForFile: (file) => webUtils.getPathForFile(file)
  },
  projects: {
    list: () => ipcRenderer.invoke(IpcChannel.Projects.list),
    create: (request) => ipcRenderer.invoke(IpcChannel.Projects.create, request),
    update: (id, request) => ipcRenderer.invoke(IpcChannel.Projects.update, id, request),
    delete: (id) => ipcRenderer.invoke(IpcChannel.Projects.delete, id),
    setActive: (id) => ipcRenderer.invoke(IpcChannel.Projects.setActive, id)
  },
  conversations: {
    list: () => ipcRenderer.invoke(IpcChannel.Conversations.list),
    save: (conversation) => ipcRenderer.invoke(IpcChannel.Conversations.save, conversation),
    delete: (id) => ipcRenderer.invoke(IpcChannel.Conversations.delete, id),
    deleteAll: () => ipcRenderer.invoke(IpcChannel.Conversations.deleteAll),
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
    readFile: (absolutePath) => ipcRenderer.invoke(IpcChannel.Attachments.readFile, absolutePath)
  },
  toast: {
    show: (content) => ipcRenderer.invoke(IpcChannel.Toast.show, content),
    focusMain: () => ipcRenderer.invoke(IpcChannel.Toast.focusMain)
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
  }
}

/** Subscribe to a main→renderer channel; returns an unsubscribe function. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('anodex', api)
