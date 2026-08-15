import type { ChatSessionModelFunction } from 'node-llama-cpp'
import type { EmailSettings, PermissionMode, WebSearchSettings } from '@shared/settings.types'
import type { ToolCall, ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import type { ChatUserFile } from '@shared/chat.types'
import type { Plan } from '@shared/plan.types'
import type { McpToolDescriptor } from '@shared/mcp.types'
import type { LoopGuardState } from './loopGuard'
import type { ToolArtifact, ToolArtifactDraft } from '@shared/toolArtifacts.types'
import type { ModelToolResultBudget } from './modelResultBudget'
import type { ReadCoverageTracker } from './readCoverage'
import type { TurnProgress } from './turnProgress'
import type { WebSourceRegistry } from './WebSourceRegistry'
import type { VisualInputQueue } from '../vision/imageInputs'

/** Cloud image API the active generation provider has explicitly opted into. */
export type ImageGenerationProvider = 'openai' | 'google'

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
  /**
   * Files the user attached to this chat. Tools that *send* a file may read
   * these regardless of whether a workspace is open — the user putting a file
   * into the conversation is what makes it fair game, not where it happens to
   * live on disk.
   *
   * Deliberately not a way around the workspace sandbox for anything else:
   * these are read-only, and every tool that writes still confines itself to
   * `workspaceRoot`.
   */
  userFiles: ChatUserFile[]
  /** Master permission mode; decides which risk levels auto-run vs. need confirmation. */
  permissionMode: PermissionMode
  /** Shell executable used by run_command, if the user configured one. */
  commandShell?: string
  /** Web search configuration used by the web_search tool. */
  webSearch: WebSearchSettings
  /** Present only for cloud providers with a first-party image generation integration. */
  imageGeneration?: { provider: ImageGenerationProvider }
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
  /**
   * Mutable per-generation flag, shared by every tool call in this
   * generation, same pattern as `plan`/`turnGate`/`loopGuard` above — set by
   * `runReadTool`/`runGuardedTool` (see `helpers.ts`) whenever a tool call
   * that did real work succeeds. `finish_goal` (see `agentTools.ts`) reads
   * this and refuses to report success if nothing else happened this turn —
   * otherwise a model can call `finish_goal` claiming work it never did
   * (observed directly: a local model claimed "Created hello2.txt" three
   * turns running without ever calling `write_file`, and the file never
   * existed on disk).
   *
   * "Real work" excludes both `read` and `plan` kinds. Reading is not doing,
   * and neither is writing down an intention: an agent run exists to carry
   * out its goal, so `write_plan`/`update_plan_step` must not be able to
   * satisfy this on their own.
   */
  progress: TurnProgress
  /**
   * Whether this turn is a goal-directed run — an Agent run, or an interactive
   * chat with a standing `/goal` (see `ChatRequest.goal`). Registers
   * `finish_goal`, which is how such a run ends itself.
   *
   * Kept separate from `enabledTools` rather than folded into it: chat goal
   * runs need the *whole* toolset plus `finish_goal`, and expressing that
   * through a restricted set would mean enumerating every tool name and
   * silently losing new ones as they are added.
   */
  goalRun: boolean
  /**
   * Read-only projection of this turn's active context budget, for sizing
   * tool results — a mutable box (same pattern as `plan`/`turnGate` above)
   * because the real, measured value isn't known until after the engine has
   * already built this context object; it fills in once, before any tool
   * call in the turn actually runs. `null` means no budget is available yet —
   * tools fall back to their own disk-oriented caps unchanged, exactly as
   * before this budget existed.
   *
   * Every transport now fills this in, and re-fills it each round as the turn
   * spends its window: the local engine and the llama-server vision path from
   * real `/tokenize` measurements, the cloud providers from the model's catalog
   * window and their own reported prompt usage (see `cloudRoundBudget.ts`).
   * Cloud used to leave it `null` permanently on the reasoning that a 200K
   * window could absorb any single result — true of one result, and not of the
   * twenty a tool-using turn can take, each re-sent on every later round.
   */
  modelResultBudget: { current: ModelToolResultBudget | null }
  /**
   * Which file line ranges have already been read this bounded task (not
   * just this one generation call) — see `ReadCoverageTracker`'s doc
   * comment. Supplied by the caller when it owns a multi-cycle/multi-turn
   * task (`BoundedChatRunner`, `AgentRunService`) so read tools can trim a
   * request down to only its genuinely new portion, or short-circuit
   * entirely, across cycle/turn boundaries — not just within one call the
   * way `loopGuard` above does. A caller with no such task (a one-shot
   * generation) gets a fresh, call-scoped instance with no cross-call
   * effect, identical to not having this at all.
   */
  readCoverage: ReadCoverageTracker
  /**
   * Optional multimodal bridge for tools that inspect workspace visuals. It is
   * present only when the active provider can consume images; text-only local
   * models therefore never see visual-inspection tools they cannot use.
   */
  visualInputs?: VisualInputQueue
  /** Research focus used to rank useful passages from large fetched pages. */
  evidenceFocus?: string
  /** Persist a full structured result before the model-facing text is truncated. */
  recordArtifact?: (artifact: ToolArtifact) => void
  /**
   * Per-turn web source registry. Web tools register what they retrieved and
   * put the returned id in their model-facing text, so the model can attribute
   * a claim to a specific page and the finished message can show what it stood
   * on. Absent for callers that don't attribute sources (Critical Thinking
   * keeps its own richer source state).
   */
  webSources?: WebSourceRegistry
  /** Return a model-facing limit message to block this call, or null to run it. */
  beforeTool?: (name: string, args: unknown) => string | null
  /**
   * Ends the current tool loop when a guard determines that further rounds are
   * unsafe or useless. The local text engine aborts its opaque native loop;
   * explicit-round transports (local vision and cloud) latch the request and
   * refuse to start another provider round. Called by
   * the loop guard once a model keeps repeating an identical call even after
   * being blocked and told to stop (see `LOOP_GUARD_ABORT_AFTER` in
   * `loopGuard.ts`) and by read-coverage escalation after repeated no-op reads.
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

export interface ToolArtifactIdentity {
  conversationId: string
  messageId: string
}

/** Add stable runtime identity to an artifact without coupling it to a tool handler. */
export function createToolArtifact(
  identity: ToolArtifactIdentity,
  draft: ToolArtifactDraft
): ToolArtifact {
  return {
    ...draft,
    id: `artifact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
    conversationId: identity.conversationId,
    messageId: identity.messageId,
    createdAt: Date.now()
  }
}

/** Add stable runtime identity to a tool-produced artifact and persist it. */
export function recordToolArtifact(
  ctx: ToolRuntimeContext,
  draft: ToolArtifactDraft
): ToolArtifact {
  const artifact = createToolArtifact(ctx, draft)
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
