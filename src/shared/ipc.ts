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
import type { CloudProviderId, ProviderUsageSnapshot } from './providerUsage.types'
import type {
  CreateScheduledTaskRequest,
  ScheduledTask,
  UpdateScheduledTaskRequest
} from './scheduledTask.types'
import type { AgentRun, CreateAgentRunRequest } from './agentRun.types'
import type {
  ApproveCriticalThinkingRequest,
  CreateCriticalThinkingRequest,
  ExportCriticalThinkingPdfRequest,
  ExportCriticalThinkingPdfResult,
  CriticalThinkingRun,
  CriticalThinkingStreamChunk
} from './criticalThinking.types'
import type { ChangeSummary } from './change.types'
import type {
  SkillDeleteRequest,
  SkillDocument,
  SkillReadRequest,
  SkillSaveRequest,
  SkillSummary
} from './skill.types'
import type {
  EmailConnectionStatus,
  EmailDraft,
  EmailDraftRequest,
  EmailListThreadsRequest,
  EmailMessage,
  EmailSearchRequest,
  EmailSendRequest,
  EmailThreadSummary
} from './email.types'
import type {
  McpNewServerConfig,
  McpServerConfig,
  McpServerCredentials,
  McpServerPatch,
  McpServerState,
  McpToolDescriptor
} from './mcp.types'
import type { GithubConnectRequest, GithubConnectionState } from './github.types'
import type { GitWorkspaceStatus } from './git.types'
import type {
  CheckpointPreview,
  CheckpointHistoryEntry,
  CheckpointRequest,
  RestoreCheckpointRequest,
  RestoreCheckpointResult,
  RollbackCheckpointsRequest,
  RollbackCheckpointsResult,
  UndoCheckpointRequest,
  UndoCheckpointResult
} from './checkpoint.types'

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
  Provider: {
    /** Test whether a cloud provider API key (and configured model) actually works. */
    verifyKey: 'provider:verify-key',
    /** Current usage snapshot for every cloud provider, computed on demand. */
    getUsageSnapshot: 'provider:get-usage-snapshot',
    /** main → renderer broadcast whenever a cloud provider's usage snapshot changes. */
    usageChanged: 'provider:usage-changed'
  },
  Settings: {
    get: 'settings:get',
    update: 'settings:update',
    openModelsDir: 'settings:open-models-dir'
  },
  Tools: {
    pickWorkspace: 'tools:pick-workspace',
    pickFolder: 'tools:pick-folder',
    /** renderer → main: user's answer to a confirmation prompt. */
    confirmResponse: 'tools:confirm-response',
    /** main → renderer: a tool call started/updated. */
    activity: 'tools:activity',
    /** main → renderer: approval is required before a write/command runs. */
    confirmRequest: 'tools:confirm-request',
    /**
     * main → renderer: a pending confirm request was already settled on the
     * main side (generation aborted while it was still awaiting an answer)
     * — the renderer must drop its card instead of leaving a dead prompt
     * sitting in `pendingConfirmations` forever.
     */
    confirmCancelled: 'tools:confirm-cancelled'
  },
  Skills: {
    list: 'skills:list',
    read: 'skills:read',
    save: 'skills:save',
    delete: 'skills:delete'
  },
  Changes: {
    /** List a project's active (non-archived) change proposals. */
    list: 'changes:list'
  },
  Checkpoints: {
    /** List a project's checkpoints, newest first. */
    list: 'checkpoints:list',
    /** Inspect changed files and detect edits made after a checkpoint was captured. */
    inspect: 'checkpoints:inspect',
    /** Restore the files changed by one assistant message back to their before-state. */
    restore: 'checkpoints:restore',
    /** Reapply the AI turn after a checkpoint restore. */
    undo: 'checkpoints:undo',
    /** Restore discarded assistant turns in reverse transcript order. */
    rollback: 'checkpoints:rollback'
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
    readFile: 'attachments:read-file',
    pickFiles: 'attachments:pick-files'
  },
  Toast: {
    /** Show a themed desktop toast in its own always-on-top window. */
    show: 'toast:show',
    /** From a toast window: bring the main window to the foreground, optionally passing a conversation to open. */
    focusMain: 'toast:focus-main',
    /** main → renderer (main window): open this conversation, requested from a clicked toast. */
    openConversation: 'toast:open-conversation'
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
  },
  Scheduler: {
    list: 'scheduler:list',
    create: 'scheduler:create',
    update: 'scheduler:update',
    delete: 'scheduler:delete',
    /** Trigger a task immediately, regardless of its schedule. */
    runNow: 'scheduler:run-now',
    getKeepAwake: 'scheduler:get-keep-awake',
    setKeepAwake: 'scheduler:set-keep-awake',
    /** main → renderer broadcast whenever tasks change (create/update/delete/run). */
    tasksChanged: 'scheduler:tasks-changed'
  },
  Agent: {
    list: 'agent:list',
    create: 'agent:create',
    stop: 'agent:stop',
    delete: 'agent:delete',
    approvePlan: 'agent:approve-plan',
    rejectPlan: 'agent:reject-plan',
    /** main → renderer broadcast whenever a run changes (create/turn/finish/delete). */
    runsChanged: 'agent:runs-changed'
  },
  CriticalThinking: {
    list: 'critical-thinking:list',
    create: 'critical-thinking:create',
    approve: 'critical-thinking:approve',
    stop: 'critical-thinking:stop',
    delete: 'critical-thinking:delete',
    exportPdf: 'critical-thinking:export-pdf',
    /** main → renderer tokens for the report currently being written. */
    stream: 'critical-thinking:stream',
    /** main → renderer whenever a plan, activity, source, or status changes. */
    runsChanged: 'critical-thinking:runs-changed'
  },
  Email: {
    getStatus: 'email:get-status',
    openGmailWeb: 'email:open-gmail-web',
    connectGmail: 'email:connect-gmail',
    disconnectGmail: 'email:disconnect-gmail',
    listThreads: 'email:list-threads',
    search: 'email:search',
    readMessage: 'email:read-message',
    createDraft: 'email:create-draft',
    send: 'email:send'
  },
  Github: {
    getState: 'github:get-state',
    connect: 'github:connect',
    disconnect: 'github:disconnect',
    detectRepository: 'github:detect-repository'
  },
  Git: {
    getStatus: 'git:get-status',
    init: 'git:init'
  },
  Mcp: {
    list: 'mcp:list',
    add: 'mcp:add',
    update: 'mcp:update',
    remove: 'mcp:remove',
    setEnabled: 'mcp:set-enabled',
    setStaticToken: 'mcp:set-static-token',
    /** Re-runs the connection (including OAuth if needed) for an already-saved server. */
    connect: 'mcp:connect',
    /** Attempts a connection without persisting it into the live tool set. */
    testConnection: 'mcp:test-connection',
    /** Clears stored credentials (static token or OAuth tokens) for a server. */
    disconnectAuth: 'mcp:disconnect-auth',
    getStatuses: 'mcp:get-statuses',
    listTools: 'mcp:list-tools',
    /** main → renderer broadcast whenever a server's connection status changes. */
    statusChanged: 'mcp:status-changed'
  }
} as const

/** Request to test whether a cloud provider API key (and model) works. */
export interface VerifyProviderKeyRequest {
  provider: 'anthropic' | 'openai'
  apiKey: string
  model: string
}

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
  provider: {
    /** Makes a cheap, metadata-only API call to confirm the key (and model) actually work. */
    verifyKey(request: VerifyProviderKeyRequest): Promise<Result<true>>
    /** Current usage snapshot for every cloud provider Anodex has any data for. */
    getUsageSnapshot(): Promise<Partial<Record<CloudProviderId, ProviderUsageSnapshot>>>
    onUsageChanged(listener: (snapshot: ProviderUsageSnapshot) => void): () => void
  }
  settings: {
    get(): Promise<AppSettings>
    update(patch: DeepPartial<AppSettings>): Promise<AppSettings>
    openModelsDir(): Promise<void>
  }
  tools: {
    /** Opens a folder picker and makes the chosen path the active workspace root. */
    pickWorkspace(): Promise<Result<string | null>>
    /** Opens a folder picker without changing global workspace/project state. */
    pickFolder(): Promise<Result<string | null>>
    /** Answer a pending write/command approval prompt. */
    respondConfirmation(id: string, response: ToolConfirmResponse): Promise<void>
    onActivity(listener: (event: ToolActivityEvent) => void): () => void
    onConfirmRequest(listener: (request: ToolConfirmRequest) => void): () => void
    /** A pending confirm request was already settled on the main side — drop its card. */
    onConfirmCancelled(listener: (id: string) => void): () => void
  }
  skills: {
    /** List project + personal skill metadata for lightweight renderer discovery. */
    list(projectId?: string | null): Promise<SkillSummary[]>
    /** Read one editable skill markdown document. */
    read(request: SkillReadRequest): Promise<SkillDocument>
    /** Validate and save one editable skill markdown document. */
    save(request: SkillSaveRequest): Promise<SkillSummary>
    /** Delete one editable skill markdown document. */
    delete(request: SkillDeleteRequest): Promise<void>
  }
  changes: {
    /** List a project's active (non-archived) change proposals. */
    list(projectId?: string | null): Promise<ChangeSummary[]>
  }
  checkpoints: {
    /** List a project's checkpoints, newest first. */
    list(projectId: string): Promise<Result<CheckpointHistoryEntry[]>>
    /** Inspect changed files and detect edits made after a checkpoint was captured. */
    inspect(request: CheckpointRequest): Promise<Result<CheckpointPreview>>
    /** Restore the files changed by one assistant message back to their before-state. */
    restore(request: RestoreCheckpointRequest): Promise<Result<RestoreCheckpointResult>>
    /** Reapply the AI turn after a checkpoint restore. */
    undo(request: UndoCheckpointRequest): Promise<Result<UndoCheckpointResult>>
    /** Restore all checkpointed changes discarded by a past-message edit. */
    rollback(request: RollbackCheckpointsRequest): Promise<Result<RollbackCheckpointsResult>>
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
    /** Open a native multi-select file picker for composer attachments. Empty array if cancelled. */
    pickFiles(): Promise<{ path: string; name: string }[]>
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
    /** Bring the main window to the foreground — called when a toast is clicked. Pass the toast's
     *  conversationId (if any) to also have the main window open it. */
    focusMain(conversationId?: string): Promise<void>
    /** Fires in the main window when a clicked toast asked to open a specific conversation. */
    onOpenConversation(listener: (conversationId: string) => void): () => void
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
  scheduler: {
    list(): Promise<ScheduledTask[]>
    create(request: CreateScheduledTaskRequest): Promise<ScheduledTask>
    update(id: string, request: UpdateScheduledTaskRequest): Promise<ScheduledTask>
    delete(id: string): Promise<void>
    /** Trigger a task immediately, regardless of its schedule. */
    runNow(id: string): Promise<void>
    getKeepAwake(): Promise<boolean>
    setKeepAwake(value: boolean): Promise<boolean>
    onTasksChanged(listener: (tasks: ScheduledTask[]) => void): () => void
  }
  agent: {
    list(): Promise<AgentRun[]>
    create(request: CreateAgentRunRequest): Promise<AgentRun>
    stop(id: string): Promise<void>
    delete(id: string): Promise<void>
    approvePlan(id: string): Promise<void>
    rejectPlan(id: string): Promise<void>
    onRunsChanged(listener: (runs: AgentRun[]) => void): () => void
  }
  criticalThinking: {
    list(): Promise<CriticalThinkingRun[]>
    create(request: CreateCriticalThinkingRequest): Promise<CriticalThinkingRun>
    approve(id: string, request: ApproveCriticalThinkingRequest): Promise<CriticalThinkingRun>
    stop(id: string): Promise<void>
    delete(id: string): Promise<void>
    exportPdf(request: ExportCriticalThinkingPdfRequest): Promise<ExportCriticalThinkingPdfResult>
    onStream(listener: (chunk: CriticalThinkingStreamChunk) => void): () => void
    onRunsChanged(listener: (runs: CriticalThinkingRun[]) => void): () => void
  }
  email: {
    getStatus(): Promise<Result<EmailConnectionStatus>>
    openGmailWeb(): Promise<Result<void>>
    connectGmail(): Promise<Result<EmailConnectionStatus>>
    disconnectGmail(): Promise<Result<EmailConnectionStatus>>
    listThreads(request?: EmailListThreadsRequest): Promise<Result<EmailThreadSummary[]>>
    search(request: EmailSearchRequest): Promise<Result<EmailThreadSummary[]>>
    readMessage(id: string): Promise<Result<EmailMessage>>
    createDraft(request: EmailDraftRequest): Promise<Result<EmailDraft>>
    send(request: EmailSendRequest): Promise<Result<void>>
  }
  github: {
    getState(projectId?: string | null): Promise<Result<GithubConnectionState>>
    connect(
      request: GithubConnectRequest,
      projectId?: string | null
    ): Promise<Result<GithubConnectionState>>
    disconnect(projectId?: string | null): Promise<Result<GithubConnectionState>>
    detectRepository(projectId: string): Promise<Result<string | null>>
  }
  git: {
    getStatus(projectId: string): Promise<Result<GitWorkspaceStatus>>
    init(projectId: string): Promise<Result<GitWorkspaceStatus>>
  }
  mcp: {
    list(): Promise<McpServerConfig[]>
    add(
      config: McpNewServerConfig,
      credentials?: McpServerCredentials
    ): Promise<Result<McpServerConfig>>
    update(
      id: string,
      patch: McpServerPatch,
      credentials?: McpServerCredentials
    ): Promise<Result<McpServerConfig>>
    remove(id: string): Promise<Result<void>>
    setEnabled(id: string, enabled: boolean): Promise<Result<McpServerConfig>>
    /** Stores a pasted bearer token for a remote server and reconnects using it instead of OAuth. */
    setStaticToken(id: string, token: string): Promise<Result<void>>
    /** Re-runs the connection (including OAuth if needed) for an already-saved server. */
    connect(id: string): Promise<Result<void>>
    /** Attempts a connection without persisting it into the live tool set — for a "Test connection" action. */
    testConnection(
      config: McpServerConfig
    ): Promise<Result<{ ok: true; toolCount: number } | { ok: false; error: string }>>
    /** Clears stored credentials (static token or OAuth tokens) so the next connect starts fresh. */
    disconnectAuth(id: string): Promise<Result<void>>
    getStatuses(): Promise<McpServerState[]>
    /** Every tool currently discovered across all connected servers. */
    listTools(): Promise<McpToolDescriptor[]>
    onStatusChanged(listener: (state: McpServerState) => void): () => void
  }
}
