import { IpcChannel } from '@shared/ipc'
import { broadcastToWindows } from '../broadcast'
import { llamaService } from '../llama/LlamaService'
import { chatEvents } from '../chat/chatEvents'
import { providerUsageStore } from '../llm/ProviderUsageStore'
import { registerChatHandlers } from './chat.handlers'
import { registerModelHandlers } from './model.handlers'
import { registerConversationHandlers } from './conversation.handlers'
import { registerBackupHandlers } from './backup.handlers'
import { registerProjectHandlers } from './project.handlers'
import { registerSettingsHandlers } from './settings.handlers'
import { registerProviderHandlers } from './provider.handlers'
import { registerSystemHandlers } from './system.handlers'
import { registerToolHandlers } from './tools.handlers'
import { registerWindowHandlers } from './window.handlers'
import { registerWorkspaceHandlers } from './workspace.handlers'
import { registerToastHandlers } from './toast.handlers'
import { registerAttachmentHandlers } from './attachments.handlers'
import { registerUpdateHandlers } from './update.handlers'
import { registerStatsHandlers } from './stats.handlers'
import { registerDiagnosticsHandlers } from './diagnostics.handlers'
import { registerMemoryHandlers } from './memory.handlers'
import { registerSkillHandlers } from './skill.handlers'
import { registerChangeHandlers } from './change.handlers'
import { registerCheckpointHandlers } from './checkpoint.handlers'
import { registerTerminalHandlers } from './terminal.handlers'
import { registerSchedulerHandlers } from './scheduler.handlers'
import { registerAgentHandlers } from './agent.handlers'
import { registerCriticalThinkingHandlers } from './criticalThinking.handlers'
import { registerEmailHandlers } from './email.handlers'
import { registerMcpHandlers } from './mcp.handlers'
import { registerGithubHandlers } from './github.handlers'
import { registerGitHandlers } from './git.handlers'
import { registerContextMenuHandlers } from '../contextMenu'
import { mcpManager } from '../mcp/McpManager'

/**
 * Register every IPC handler and wire engine state broadcasts.
 * Call once, after the app is ready.
 */
export function registerIpcHandlers(): void {
  registerModelHandlers()
  registerChatHandlers()
  registerSettingsHandlers()
  registerProviderHandlers()
  registerProjectHandlers()
  registerConversationHandlers()
  registerBackupHandlers()
  registerSystemHandlers()
  registerToolHandlers()
  registerWindowHandlers()
  registerWorkspaceHandlers()
  registerToastHandlers()
  registerAttachmentHandlers()
  registerUpdateHandlers()
  registerStatsHandlers()
  registerDiagnosticsHandlers()
  registerMemoryHandlers()
  registerSkillHandlers()
  registerChangeHandlers()
  registerCheckpointHandlers()
  registerTerminalHandlers()
  registerSchedulerHandlers()
  registerAgentHandlers()
  registerCriticalThinkingHandlers()
  registerEmailHandlers()
  registerGithubHandlers()
  registerGitHandlers()
  registerMcpHandlers()
  registerContextMenuHandlers()

  // Push engine state changes to every open renderer window.
  llamaService.on('state', (state) => {
    broadcastToWindows(IpcChannel.Models.stateChanged, state)
  })

  // Push context-compaction notices to every open renderer window. Local
  // generations emit via `llamaService`; cloud generations (no engine object
  // of their own) emit the identical event shape via `chatEvents` instead —
  // both funnel into the same IPC channel below.
  llamaService.on('historyCompacted', (event) => {
    broadcastToWindows(IpcChannel.Chat.historyCompacted, event)
  })
  chatEvents.on('historyCompacted', (event) => {
    broadcastToWindows(IpcChannel.Chat.historyCompacted, event)
  })

  // Push cloud provider usage snapshot changes to every open renderer window.
  providerUsageStore.on('change', (snapshot) => {
    broadcastToWindows(IpcChannel.Provider.usageChanged, snapshot)
  })

  // Push MCP server connection status changes to every open renderer window.
  mcpManager.on('statusChanged', (state) => {
    broadcastToWindows(IpcChannel.Mcp.statusChanged, state)
  })
}
