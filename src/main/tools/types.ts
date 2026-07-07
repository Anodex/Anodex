import type { ChatSessionModelFunction } from 'node-llama-cpp'
import type { PermissionMode, WebSearchSettings } from '@shared/settings.types'
import type { ToolCall, ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import type { Plan } from '@shared/plan.types'

/** The `node-llama-cpp` module type (dynamically imported at runtime). */
type NlcModule = typeof import('node-llama-cpp')
export type DefineChatSessionFunction = NlcModule['defineChatSessionFunction']
/**
 * A single tool as understood by the engine's chat session. Kept schema-agnostic
 * (`<any>`) so tools with different parameter shapes collect into one map.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolFunction = ChatSessionModelFunction<any>

/**
 * Everything a tool handler needs at call time. Built fresh per generation so
 * the workspace, approval policy, and UI callbacks are always current.
 *
 * `workspaceRoot` is null when no workspace folder is selected — in that mode
 * only workspace-independent tools (e.g. web tools) are registered.
 */
export interface ToolRuntimeContext {
  conversationId: string
  messageId: string
  /** Id of the active project, or null in a general (non-project) chat. Used for project memory. */
  projectId: string | null
  /** Absolute path all workspace tools are confined to, or null if none. */
  workspaceRoot: string | null
  /** Master permission mode; decides which risk levels auto-run vs. need confirmation. */
  permissionMode: PermissionMode
  /** Shell executable used by run_command, if the user configured one. */
  commandShell?: string
  /** Web search configuration used by the web_search tool. */
  webSearch: WebSearchSettings
  /** Which memory scopes are on; gates the remember_fact tool and which scope it can write to. */
  memory: { crossChatEnabled: boolean; personalEnabled: boolean }
  /**
   * Mutable holder for the conversation's current plan, shared by every tool
   * call in this generation — `write_plan` sets it, `update_plan_step` reads
   * and mutates it, so a later call in the same turn sees an earlier one's
   * result without needing separate storage.
   */
  plan: { current: Plan | null }
  signal?: AbortSignal
  /** Report a tool call's progress to the UI. */
  emit: (call: ToolCall) => void
  /** Ask the user to approve a write/command; resolves to their decision. */
  confirm: (request: ToolConfirmRequest) => Promise<ToolConfirmResponse>
}

/** Runtime context guaranteed to have a workspace, for workspace-scoped tools. */
export type WorkspaceToolContext = Omit<ToolRuntimeContext, 'workspaceRoot'> & {
  workspaceRoot: string
}

/** Constructs a workspace-independent tool (e.g. web tools). */
export type ToolFactory = (
  define: DefineChatSessionFunction,
  ctx: ToolRuntimeContext
) => ToolFunction

/** Constructs a workspace-scoped tool; only built when a workspace is set. */
export type WorkspaceToolFactory = (
  define: DefineChatSessionFunction,
  ctx: WorkspaceToolContext
) => ToolFunction
