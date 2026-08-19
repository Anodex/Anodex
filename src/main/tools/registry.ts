import type {
  DefineChatSessionFunction,
  ToolFactory,
  ToolFunction,
  ToolRuntimeContext,
  WorkspaceToolContext,
  WorkspaceToolFactory
} from './types'
import {
  listDirectoryTool,
  readFileTool,
  searchFilesTool,
  findFilesTool,
  getFileInfoTool,
  readFileRangeTool,
  readMultipleFilesTool
} from './fileTools'
import { previewHtmlTool } from './previewTools'
import { showImageTool } from './imageDisplayTools'
import { inspectVisualTool } from './visualInspectionTools'
import { computerControlTool } from './computerControlTool'
import { computerControlService } from '../computerControl/ComputerControlService'
import {
  editFileTool,
  appendFileTool,
  writeFileTool,
  patchFileTool,
  replaceLinesTool,
  deleteFileTool,
  moveFileTool
} from './mutationTools'
import { runCommandTool } from './commandTools'
import { runProjectCheckTool } from './diagnosticsTools'
import { createDirectoryTool, deleteDirectoryTool } from './directoryTools'
import { gitStatusTool, gitDiffTool } from './gitTools'
import { gitCommitSummaryTool } from './gitCommitTools'
import { codeOutlineTool } from './codeOutlineTools'
import { searchCodeTool } from './codeSearchTools'
import { fetchUrlTool } from './webTools'
import { webSearchTool } from './webSearchTools'
import { generateImageTool } from './imageGenerationTool'
import { writePlanTool, updatePlanStepTool } from './planTools'
import { updateProjectNotesTool } from './projectNotesTool'
import { rememberFactTool } from './memoryTool'
import { findSkillTool, loadSkillTool } from './skillTools'
import {
  proposeChangeTool,
  updateChangeTaskTool,
  archiveChangeTool,
  listChangesTool
} from './changeTools'
import { finishGoalTool } from './agentTools'
import { buildMcpToolFunction } from './mcpTools'
import { scheduleTaskTool } from './schedulerTools'
import {
  batchEmailTool,
  draftEmailTool,
  findEmailAttachmentsTool,
  forwardEmailTool,
  listEmailAccountsTool,
  listEmailMailboxesTool,
  listEmailThreadsTool,
  manageEmailTool,
  moveEmailTool,
  readEmailAttachmentTool,
  readEmailTool,
  replyEmailTool,
  saveEmailAttachmentTool,
  saveEmailDraftTool,
  searchEmailTool,
  sendEmailTool,
  summarizeEmailThreadTool,
  viewEmailAttachmentTool
} from './emailTools'

/**
 * Read-only workspace tools — available whenever a workspace folder is
 * selected, with or without an open project. Lets a plain "My workspace"
 * chat look at code and discuss it without being able to change anything.
 */
const READ_ONLY_WORKSPACE_FACTORIES: Record<string, WorkspaceToolFactory> = {
  list_directory: listDirectoryTool,
  read_file: readFileTool,
  search_files: searchFilesTool,
  find_files: findFilesTool,
  get_file_info: getFileInfoTool,
  read_file_range: readFileRangeTool,
  read_multiple_files: readMultipleFilesTool,
  preview_html: previewHtmlTool,
  show_image: showImageTool,
  code_outline: codeOutlineTool,
  git_status: gitStatusTool,
  git_diff: gitDiffTool,
  git_commit_summary: gitCommitSummaryTool
}

/** Exposed only when the active provider can receive tool-produced image parts. */
const VISUAL_WORKSPACE_FACTORIES: Record<string, WorkspaceToolFactory> = {
  inspect_visual: inspectVisualTool
}

/**
 * Mutating/executing workspace tools — only registered when a project is
 * open (`ctx.projectId` set), not just a workspace folder. Editing is
 * deliberately a project action: a plain chat can read and advise, but
 * actually changing files always happens inside a project.
 */
const PROJECT_WORKSPACE_FACTORIES: Record<string, WorkspaceToolFactory> = {
  write_file: writeFileTool,
  append_file: appendFileTool,
  edit_file: editFileTool,
  replace_lines: replaceLinesTool,
  patch_file: patchFileTool,
  delete_file: deleteFileTool,
  move_file: moveFileTool,
  create_directory: createDirectoryTool,
  delete_directory: deleteDirectoryTool,
  run_command: runCommandTool,
  run_project_check: runProjectCheckTool,
  update_project_notes: updateProjectNotesTool,
  propose_change: proposeChangeTool,
  update_change_task: updateChangeTaskTool,
  archive_change: archiveChangeTool,
  list_changes: listChangesTool
}

/**
 * Read-only, but still project-only, unlike `READ_ONLY_WORKSPACE_FACTORIES`
 * above: `search_code`'s index is persisted per-project (see
 * `CodeIndexStore`), so it has nothing to search in a plain workspace-only
 * chat with no project open — kept as its own small group rather than
 * folded into `PROJECT_WORKSPACE_FACTORIES` so that group's "editing is
 * deliberately a project action" framing doesn't misdescribe a read tool.
 */
const PROJECT_READ_ONLY_FACTORIES: Record<string, WorkspaceToolFactory> = {
  search_code: searchCodeTool
}

/**
 * A general (non-project) chat has no workspace or project to scope a fact
 * to, but the user can still share something worth remembering globally (e.g.
 * their name) — so `remember_fact` is NOT gated behind `ctx.workspaceRoot`/
 * `ctx.projectId` like the tools above. It resolves its own scope at call
 * time (see `resolveMemoryScope` in `memoryTool.ts`), honoring whichever
 * memory toggle(s) are on.
 */

/** Tools that need no workspace (always available when tools are enabled). */
const GLOBAL_FACTORIES: Record<string, ToolFactory> = {
  fetch_url: fetchUrlTool,
  write_plan: writePlanTool,
  update_plan_step: updatePlanStepTool,
  find_skill: findSkillTool,
  load_skill: loadSkillTool,
  schedule_task: scheduleTaskTool
}

const EMAIL_FACTORIES: Record<string, ToolFactory> = {
  list_email_accounts: listEmailAccountsTool,
  list_threads: listEmailThreadsTool,
  search_email: searchEmailTool,
  read_email: readEmailTool,
  read_email_attachment: readEmailAttachmentTool,
  summarize_thread: summarizeEmailThreadTool,
  find_attachments: findEmailAttachmentsTool,
  list_mailboxes: listEmailMailboxesTool,
  draft_email: draftEmailTool,
  save_email_draft: saveEmailDraftTool,
  send_email: sendEmailTool,
  reply_email: replyEmailTool,
  forward_email: forwardEmailTool,
  manage_email: manageEmailTool,
  move_email: moveEmailTool,
  batch_email: batchEmailTool
}

/**
 * Email tools that need a vision-capable provider but no workspace. Kept apart
 * from `VISUAL_WORKSPACE_FACTORIES` because that group is registered inside the
 * `ctx.workspaceRoot` branch — an email image has nothing to do with a project
 * folder, and the Email page's assistant rail usually has neither.
 */
const EMAIL_VISUAL_FACTORIES: Record<string, ToolFactory> = {
  view_email_attachment: viewEmailAttachmentTool
}

const EMAIL_WORKSPACE_FACTORIES: Record<string, WorkspaceToolFactory> = {
  save_email_attachment: saveEmailAttachmentTool
}

/**
 * Instantiate the tools available for a generation, producing the `functions`
 * map the engine's chat session expects.
 *
 * - Read-only workspace tools are registered whenever a workspace folder is
 *   selected, project or not.
 * - Mutating/executing workspace tools additionally require an open project
 *   (`ctx.projectId`) — a plain chat can read and discuss code but never
 *   change it; that only happens inside a project.
 * - Web tools (`fetch_url`, and `web_search` when a provider is configured) are
 *   always available, so web lookups work even in general, non-coding chats.
 */
export function buildTools(
  define: DefineChatSessionFunction,
  ctx: ToolRuntimeContext
): Record<string, ToolFunction> {
  const tools: Record<string, ToolFunction> = {}
  const isEnabled = (name: string): boolean =>
    !ctx.disabledTools.has(name) && (ctx.enabledTools === null || ctx.enabledTools.has(name))

  if (ctx.workspaceRoot) {
    const workspaceCtx: WorkspaceToolContext = { ...ctx, workspaceRoot: ctx.workspaceRoot }
    for (const [name, factory] of Object.entries(READ_ONLY_WORKSPACE_FACTORIES)) {
      if (isEnabled(name)) tools[name] = factory(define, workspaceCtx)
    }
    if (ctx.visualInputs) {
      for (const [name, factory] of Object.entries(VISUAL_WORKSPACE_FACTORIES)) {
        if (isEnabled(name)) tools[name] = factory(define, workspaceCtx)
      }
      // A session is only ever started by the visible renderer for one
      // interactive conversation; scheduled, agent, and research runs have
      // no matching session and therefore never receive this tool.
      if (
        isEnabled('computer_control') &&
        // A visible session is started only from interactive chat. Explicitly
        // reject every restricted/headless run even if one happens to reuse a
        // conversation id, so scheduler and agent execution can never obtain
        // a computer-input capability.
        ctx.enabledTools === null &&
        computerControlService.hasActiveVisionSession(ctx.conversationId)
      ) {
        tools.computer_control = computerControlTool(define, ctx)
      }
    }
    if (ctx.projectId) {
      for (const [name, factory] of Object.entries(PROJECT_WORKSPACE_FACTORIES)) {
        if (isEnabled(name)) tools[name] = factory(define, workspaceCtx)
      }
      for (const [name, factory] of Object.entries(PROJECT_READ_ONLY_FACTORIES)) {
        if (isEnabled(name)) tools[name] = factory(define, workspaceCtx)
      }
    }
  }

  for (const [name, factory] of Object.entries(GLOBAL_FACTORIES)) {
    if (isEnabled(name)) tools[name] = factory(define, ctx)
  }

  if (ctx.imageGeneration && isEnabled('generate_image')) {
    tools.generate_image = generateImageTool(define, ctx)
  }

  if (ctx.webSearch.provider !== 'none' && isEnabled('web_search')) {
    tools.web_search = webSearchTool(define, ctx)
  }

  // Email tools appear once any account is linked, whatever its provider —
  // the tools resolve the account themselves and never name Gmail specifically.
  if (ctx.email.accounts.length > 0) {
    for (const [name, factory] of Object.entries(EMAIL_FACTORIES)) {
      if (isEnabled(name)) tools[name] = factory(define, ctx)
    }
    if (ctx.visualInputs) {
      for (const [name, factory] of Object.entries(EMAIL_VISUAL_FACTORIES)) {
        if (isEnabled(name)) tools[name] = factory(define, ctx)
      }
    }
    if (ctx.workspaceRoot && ctx.projectId) {
      const workspaceCtx: WorkspaceToolContext = { ...ctx, workspaceRoot: ctx.workspaceRoot }
      for (const [name, factory] of Object.entries(EMAIL_WORKSPACE_FACTORIES)) {
        if (isEnabled(name)) tools[name] = factory(define, workspaceCtx)
      }
    }
  }

  // Available in every chat, project or not — see the comment on
  // `PROJECT_WORKSPACE_FACTORIES` above. Disappears entirely only when both
  // memory scopes are turned off.
  if ((ctx.memory.crossChatEnabled || ctx.memory.personalEnabled) && isEnabled('remember_fact')) {
    tools.remember_fact = rememberFactTool(define, ctx)
  }

  // finish_goal exists only for a goal-directed run: a restricted run that
  // explicitly includes it in `enabledTools` (`AgentRunService` always does),
  // or a turn that set `goalRun` — an interactive chat with a standing
  // `/goal`. An ordinary chat turn has neither, so this never registers there,
  // and it is not in `TOOL_CATALOG`, so no picker UI ever offers it.
  //
  // The two conditions are separate on purpose. A chat goal run needs the
  // whole toolset *plus* `finish_goal`; expressing that as a restricted set
  // would mean listing every tool by name and quietly dropping new ones.
  if ((ctx.goalRun || ctx.enabledTools !== null) && isEnabled('finish_goal')) {
    tools.finish_goal = finishGoalTool(define, ctx)
  }

  // MCP tools are workspace-independent, like web tools — a connected server
  // is available in any chat, project or not. Each one still goes through
  // `isEnabled` so the existing enable/disable + scheduled-task tool-set
  // restriction machinery covers them for free, same as everything else.
  for (const descriptor of ctx.mcpTools) {
    if (isEnabled(descriptor.qualifiedName)) {
      tools[descriptor.qualifiedName] = buildMcpToolFunction(define, ctx, descriptor)
    }
  }

  return tools
}
