/**
 * The single source of truth for the main ⇄ renderer boundary.
 *
 * `IpcChannel` enumerates every channel name so main handlers and the preload
 * bridge can never drift apart. `AnodexApi` is the typed surface exposed on
 * `window.anodex`; the renderer only ever talks to the main process through it.
 */

import type { Result } from './result'
import type {
  EngineState,
  ModelDownloadProgress,
  ModelInfo,
  ModelLoadOptions,
  ModelSettingsRecommendation
} from './model.types'
import type { ModelReliabilityRecord } from './modelReliability.types'
import type { RecommendedModel } from './recommendedModels'
import type {
  AttachmentContent,
  ChatCompactRequest,
  ChatCompactResult,
  ChatRequest,
  ChatResult,
  ChatStreamChunk,
  ChatTitleRequest,
  HistoryCompactionEvent
} from './chat.types'
import type { AppSettings, DeepPartial } from './settings.types'
import type {
  CreateProjectRequest,
  Project,
  ProjectsState,
  UpdateProjectRequest
} from './project.types'
import type { Conversation, ConversationState } from './conversation.types'
import type { HardwareInfo, SystemInfo } from './system.types'
import type { ToolActivityEvent, ToolConfirmRequest, ToolConfirmResponse } from './tools.types'
import type { WorkspaceTreeNode } from './workspaceFiles.types'
import type { WorkspaceFileContent } from './workspaceFileContent.types'
import type { ToastContent } from './toast.types'
import type { UpdateStatus } from './update.types'
import type { ChartGranularity, ChartRange, UsageBreakdown, UsageProfile } from './stats.types'
import type {
  CreateMemoryRequest,
  MemoryEntry,
  MemoryScope,
  UpdateMemoryRequest
} from './memory.types'

export const IpcChannel = {
  Models: {
    list: 'models:list',
    add: 'models:add',
    load: 'models:load',
    unload: 'models:unload',
    getState: 'models:get-state',
    /** main → renderer broadcast when engine state changes. */
    stateChanged: 'models:state-changed',
    download: 'models:download',
    cancelDownload: 'models:cancel-download',
    /** main → renderer broadcast with download progress. */
    downloadProgress: 'models:download-progress',
    getReliability: 'models:get-reliability',
    recommendSettings: 'models:recommend-settings',
    /** Live-search Hugging Face for downloadable GGUF models. */
    discover: 'models:discover',
    /** Auto-populate "Recommended for your PC" with current models from trusted publishers. */
    fetchTopModels: 'models:fetch-top-models'
  },
  Chat: {
    send: 'chat:send',
    stop: 'chat:stop',
    compact: 'chat:compact',
    /** main → renderer streamed tokens. */
    stream: 'chat:stream',
    /** A short local-model summary of a finished reply, for a desktop toast's title. */
    summarize: 'chat:summarize',
    /** A short generated title for a conversation's first user/assistant turn. */
    title: 'chat:title',
    /** main → renderer broadcast when older conversation turns were summarized to fit context. */
    historyCompacted: 'chat:history-compacted'
  },
  Settings: {
    get: 'settings:get',
    update: 'settings:update',
    openModelsDir: 'settings:open-models-dir'
  },
  Tools: {
    pickWorkspace: 'tools:pick-workspace',
    /** renderer → main: user's answer to a confirmation prompt. */
    confirmResponse: 'tools:confirm-response',
    /** main → renderer: a tool call started/updated. */
    activity: 'tools:activity',
    /** main → renderer: approval is required before a write/command runs. */
    confirmRequest: 'tools:confirm-request'
  },
  Projects: {
    list: 'projects:list',
    listArchived: 'projects:list-archived',
    create: 'projects:create',
    update: 'projects:update',
    delete: 'projects:delete',
    restore: 'projects:restore',
    deletePermanent: 'projects:delete-permanent',
    setActive: 'projects:set-active',
    openFolder: 'projects:open-folder'
  },
  Conversations: {
    list: 'conversations:list',
    listArchived: 'conversations:list-archived',
    save: 'conversations:save',
    delete: 'conversations:delete',
    restore: 'conversations:restore',
    deletePermanent: 'conversations:delete-permanent',
    deleteAll: 'conversations:delete-all',
    deleteArchived: 'conversations:delete-archived',
    getState: 'conversations:get-state',
    setState: 'conversations:set-state'
  },
  System: {
    getInfo: 'system:get-info',
    getHardwareInfo: 'system:get-hardware-info'
  },
  Window: {
    minimize: 'window:minimize',
    maximize: 'window:maximize',
    close: 'window:close',
    isMaximized: 'window:is-maximized',
    maximizedChanged: 'window:maximized-changed'
  },
  ContextMenu: {
    /** main -> renderer: show a themed context menu at the given renderer coordinates. */
    show: 'context-menu:show',
    /** renderer -> main: run one of the generated actions from the latest context menu. */
    runAction: 'context-menu:run-action'
  },
  Workspace: {
    listFiles: 'workspace:list-files',
    getAbsolutePath: 'workspace:get-absolute-path',
    revealInFileExplorer: 'workspace:reveal-in-explorer',
    openPath: 'workspace:open-path',
    deletePath: 'workspace:delete-path',
    readFileContent: 'workspace:read-file-content',
    writeFileContent: 'workspace:write-file-content'
  },
  Attachments: {
    readFile: 'attachments:read-file'
  },
  Toast: {
    /** Show a themed desktop toast in its own always-on-top window. */
    show: 'toast:show',
    /** From a toast window: bring the main window to the foreground. */
    focusMain: 'toast:focus-main'
  },
  Updates: {
    getStatus: 'updates:get-status',
    check: 'updates:check',
    download: 'updates:download',
    installAndRestart: 'updates:install-and-restart',
    /** main → renderer broadcast whenever the update state changes. */
    statusChanged: 'updates:status-changed'
  },
  Stats: {
    getUsageProfile: 'stats:get-usage-profile',
    getUsageBreakdown: 'stats:get-usage-breakdown'
  },
  Memory: {
    list: 'memory:list',
    create: 'memory:create',
    update: 'memory:update',
    delete: 'memory:delete'
  },
  Terminal: {
    create: 'terminal:create',
    write: 'terminal:write',
    resize: 'terminal:resize',
    kill: 'terminal:kill',
    data: 'terminal:data',
    exit: 'terminal:exit'
  }
} as const

export interface ContextMenuItem {
  id: string
  label: string
  enabled: boolean
  type?: 'separator'
}

export interface ContextMenuRequest {
  x: number
  y: number
  items: ContextMenuItem[]
}

/**
 * The typed API exposed to the renderer as `window.anodex`.
 * Each `on*` method returns an unsubscribe function.
 */
export interface AnodexApi {
  models: {
    list(): Promise<Result<ModelInfo[]>>
    /** Opens a file picker for a `.gguf` file; resolves `null` if cancelled. */
    add(): Promise<Result<ModelInfo | null>>
    load(options: ModelLoadOptions): Promise<Result<EngineState>>
    unload(): Promise<Result<EngineState>>
    getState(): Promise<EngineState>
    onStateChanged(listener: (state: EngineState) => void): () => void
    /** Download a recommended model into the models directory. */
    download(model: RecommendedModel): Promise<Result<ModelInfo>>
    cancelDownload(modelId: string): Promise<void>
    onDownloadProgress(listener: (progress: ModelDownloadProgress) => void): () => void
    /** Usage-based reliability stats for every model that has actually been run. */
    getReliability(): Promise<Result<ModelReliabilityRecord[]>>
    /**
     * Reads `path`'s own GGUF metadata and recommends a context size (and
     * other runtime settings) for it on this hardware. Works for any local
     * `.gguf` file — a catalog download or one the user added themselves.
     */
    recommendSettingsForFile(path: string): Promise<Result<ModelSettingsRecommendation>>
    /** Live-search Hugging Face for downloadable GGUF models matching `query`. */
    discover(query: string): Promise<Result<RecommendedModel[]>>
    /** Auto-populate "Recommended for your PC" with current models from trusted publishers. */
    fetchTopModels(): Promise<Result<RecommendedModel[]>>
  }
  chat: {
    send(request: ChatRequest): Promise<Result<ChatResult>>
    stop(conversationId: string): Promise<void>
    compact(request: ChatCompactRequest): Promise<Result<ChatCompactResult | null>>
    onStream(listener: (chunk: ChatStreamChunk) => void): () => void
    /** Best-effort local summary of `text` in `maxWords` words or fewer; `null` if it failed. */
    summarize(text: string, maxWords: number): Promise<string | null>
    /** Best-effort local title for a finished first turn; `null` if it failed. */
    title(request: ChatTitleRequest): Promise<string | null>
    /** Fires when older conversation turns were summarized to fit the model's context window. */
    onHistoryCompacted(listener: (event: HistoryCompactionEvent) => void): () => void
  }
  settings: {
    get(): Promise<AppSettings>
    update(patch: DeepPartial<AppSettings>): Promise<AppSettings>
    openModelsDir(): Promise<void>
  }
  tools: {
    /** Opens a folder picker; resolves the chosen path, or `null` if cancelled. */
    pickWorkspace(): Promise<Result<string | null>>
    /** Answer a pending write/command approval prompt. */
    respondConfirmation(id: string, response: ToolConfirmResponse): Promise<void>
    onActivity(listener: (event: ToolActivityEvent) => void): () => void
    onConfirmRequest(listener: (request: ToolConfirmRequest) => void): () => void
  }
  projects: {
    list(): Promise<ProjectsState>
    listArchived(): Promise<Project[]>
    create(request: CreateProjectRequest): Promise<Project>
    update(id: string, request: UpdateProjectRequest): Promise<Project>
    delete(id: string): Promise<void>
    restore(id: string): Promise<void>
    deletePermanent(id: string): Promise<void>
    setActive(id: string | null): Promise<ProjectsState>
    openFolder(id: string): Promise<void>
  }
  conversations: {
    list(): Promise<Conversation[]>
    listArchived(): Promise<Conversation[]>
    save(conversation: Conversation): Promise<void>
    delete(id: string): Promise<void>
    restore(id: string): Promise<void>
    deletePermanent(id: string): Promise<void>
    /** Archive every active conversation (all projects and general chats). */
    deleteAll(): Promise<void>
    deleteArchived(ids: string[]): Promise<void>
    getState(): Promise<ConversationState>
    setState(state: ConversationState): Promise<void>
  }
  windowControls: {
    minimize(): Promise<void>
    maximize(): Promise<void>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    onMaximizedChanged(listener: (maximized: boolean) => void): () => void
  }
  contextMenu: {
    onShow(listener: (request: ContextMenuRequest) => void): () => void
    runAction(id: string): Promise<void>
  }
  workspace: {
    /** Files in the active workspace, each attributed to the user or the AI. */
    listFiles(): Promise<Result<WorkspaceTreeNode[]>>
    /** Resolve a workspace-relative path to an absolute one, for copying. */
    getAbsolutePath(relativePath: string): Promise<Result<string>>
    /** Reveal a file in the OS's file explorer/finder. */
    revealInFileExplorer(relativePath: string): Promise<Result<void>>
    /** Open a file with its OS-registered default application. */
    openPath(relativePath: string): Promise<Result<void>>
    /** Move a file or folder to the OS Recycle Bin/Trash (recoverable). */
    deletePath(relativePath: string): Promise<Result<void>>
    /** Read a workspace file's contents for the in-app viewer/editor. */
    readFileContent(relativePath: string): Promise<Result<WorkspaceFileContent>>
    /** Save new contents to a workspace file from the in-app editor (direct user action, not AI-gated). */
    writeFileContent(relativePath: string, content: string): Promise<Result<void>>
  }
  attachments: {
    /** Read a file dropped/dragged into the composer, by absolute path. Not workspace-sandboxed —
     *  the user explicitly chose this file (via OS drag-drop or the Files panel), unlike an AI-initiated
     *  tool call. Large files are truncated. */
    readFile(absolutePath: string): Promise<Result<AttachmentContent>>
  }
  system: {
    getInfo(): Promise<SystemInfo>
    getHardwareInfo(): Promise<HardwareInfo>
    /** Resolve a File dropped from the OS into its real absolute path (Electron's webUtils). */
    getPathForFile(file: File): string
  }
  toast: {
    /** Show a themed desktop toast (own always-on-top window) with this content. */
    show(content: ToastContent): Promise<void>
    /** Bring the main window to the foreground — called when a toast is clicked. */
    focusMain(): Promise<void>
  }
  updates: {
    getStatus(): Promise<UpdateStatus>
    /** No-op in an unpackaged dev build. */
    check(): Promise<void>
    /** Only meaningful once status is `available`. */
    download(): Promise<void>
    /** Only meaningful once status is `downloaded` — quits and installs. */
    installAndRestart(): Promise<void>
    onStatusChanged(listener: (status: UpdateStatus) => void): () => void
  }
  stats: {
    /** All-time token-generation activity, independent of individual conversations. */
    getUsageProfile(): Promise<Result<UsageProfile>>
    /** Per-model token breakdown + a chart-ready series for a given time range/granularity. */
    getUsageBreakdown(
      range: ChartRange,
      granularity: ChartGranularity
    ): Promise<Result<UsageBreakdown>>
  }
  memory: {
    /** Every memory visible for `projectId` — its own project-scoped entries plus every global one. */
    list(projectId: string | null): Promise<Result<MemoryEntry[]>>
    create(request: CreateMemoryRequest): Promise<Result<MemoryEntry>>
    update(scope: MemoryScope, id: string, patch: UpdateMemoryRequest): Promise<Result<MemoryEntry>>
    delete(scope: MemoryScope, id: string): Promise<Result<void>>
  }
  terminal: {
    /** Start a new shell session; returns the session ID. */
    create(): Promise<Result<string>>
    /** Write data to a shell session's stdin. */
    write(sessionId: string, data: string): Promise<void>
    /** Resize the pseudo-terminal. */
    resize(sessionId: string, cols: number, rows: number): Promise<void>
    /** Kill a shell session. */
    kill(sessionId: string): Promise<void>
    /** Listen for output from a terminal session. */
    onData(listener: (payload: { sessionId: string; data: string }) => void): () => void
    /** Listen for a terminal session exiting. */
    onExit(listener: (payload: { sessionId: string }) => void): () => void
  }
}
