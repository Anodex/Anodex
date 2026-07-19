import type { ChatSessionModelFunction } from 'node-llama-cpp'
import type { EmailSettings, PermissionMode, WebSearchSettings } from '@shared/settings.types'
import type { ToolCall, ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import type { Plan } from '@shared/plan.types'
import type { McpToolDescriptor } from '@shared/mcp.types'
import type { LoopGuardState } from './loopGuard'
import type { ToolArtifact, ToolArtifactDraft } from '@shared/toolArtifacts.types'

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
  /** Email provider configuration used by email tools. */
  email: EmailSettings
  /** Which memory scopes are on; gates the remember_fact tool and which scope it can write to. */
  memory: { crossChatEnabled: boolean; personalEnabled: boolean; confirmBeforeSaving: boolean }
  /**
   * Restricts which tools get registered at all, by name. `null` means no
   * restriction (every tool the other context fields allow) — the normal
   * interactive-chat case. Used by scheduled tasks, where the user opts a
   * specific tool subset into unattended runs.
   */
  enabledTools: Set<string> | null
  /** Built-in tools disabled by the user for normal interactive chats. */
  disabledTools: Set<string>
  /**
   * Mutable holder for the conversation's current plan, shared by every tool
   * call in this generation — `write_plan` sets it, `update_plan_step` reads
   * and mutates it, so a later call in the same turn sees an earlier one's
   * result without needing separate storage.
   */
  plan: { current: Plan | null }
  /**
   * Mutable per-generation flag: has this turn's first "would otherwise
   * auto-run" gate (see `needsTurnGate` in `permissions.ts`, applies to
   * `full`/`untethered` mode) already been approved? Shared by every tool
   * call in this generation, same pattern as `plan` above — set once,
   * read/written by `runGuardedTool`.
   */
  turnGate: { approved: boolean }
  /**
   * Mutable per-generation tally of identical (name + title) calls, shared by
   * every tool call in this generation, same pattern as `plan`/`turnGate`
   * above — see `checkLoopGuard` in `loopGuard.ts`. Catches a model stuck
   * re-issuing the same call over and over instead of making progress.
   */
  loopGuard: LoopGuardState
  /** Research focus used to rank useful passages from large fetched pages. */
  evidenceFocus?: string
  /** Persist a full structured result before the model-facing text is truncated. */
  recordArtifact?: (artifact: ToolArtifact) => void
  /** Return a model-facing limit message to block this call, or null to run it. */
  beforeTool?: (name: string, args: unknown) => string | null
  /**
   * Force-ends the current generation outright, when the engine supports it
   * (currently local-only — see `LlamaService`'s `genController`). Called by
   * the loop guard once a model keeps repeating an identical call even after
   * being blocked and told to stop (see `LOOP_GUARD_ABORT_AFTER` in
   * `loopGuard.ts`) — cloud providers don't need this since their explicit
   * per-round tool loop already bounds worst-case repetition via
   * `MAX_TOOL_ROUNDS`, unlike the local engine's opaque internal
   * function-calling loop, which can spin many times within a single round.
   */
  abortGeneration?: () => void
  signal?: AbortSignal
  /** Report a tool call's progress to the UI. */
  emit: (call: ToolCall) => void
  /**
   * Take over the transcript card pre-emitted while the model was still
   * generating this call's params (see `PendingToolCallTracker`), so this
   * call's own running/success/error emits update that card in place instead
   * of adding a second one. Undefined (or a miss) means nothing was
   * pre-emitted — use a fresh id.
   */
  claimPendingToolCallId?: (name: string) => string | undefined
  /** Ask the user to approve a write/command; resolves to their decision. */
  confirm: (request: ToolConfirmRequest) => Promise<ToolConfirmResponse>
  /**
   * Tools discovered from currently-connected MCP servers, resolved once per
   * generation from `mcpManager`'s cache (see `runGeneration.ts`) — discovery
   * itself happens at server-connect time, not per generation, so reading
   * this list is synchronous.
   */
  mcpTools: McpToolDescriptor[]
}

/** Add stable runtime identity to a tool-produced artifact and persist it. */
export function recordToolArtifact(
  ctx: ToolRuntimeContext,
  draft: ToolArtifactDraft
): ToolArtifact {
  const artifact = {
    ...draft,
    id: `artifact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
    conversationId: ctx.conversationId,
    messageId: ctx.messageId,
    createdAt: Date.now()
  }
  ctx.recordArtifact?.(artifact)
  return artifact
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
