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
import {
  editFileTool,
  writeFileTool,
  patchFileTool,
  deleteFileTool,
  moveFileTool
} from './mutationTools'
import { runCommandTool } from './commandTools'
import { createDirectoryTool, deleteDirectoryTool } from './directoryTools'
import { gitStatusTool, gitDiffTool } from './gitTools'
import { fetchUrlTool } from './webTools'
import { webSearchTool } from './webSearchTools'
import { writePlanTool, updatePlanStepTool } from './planTools'
import { updateProjectNotesTool } from './projectNotesTool'
import { rememberFactTool } from './memoryTool'

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
  git_status: gitStatusTool,
  git_diff: gitDiffTool
}

/**
 * Mutating/executing workspace tools — only registered when a project is
 * open (`ctx.projectId` set), not just a workspace folder. Editing is
 * deliberately a project action: a plain chat can read and advise, but
 * actually changing files always happens inside a project.
 */
const PROJECT_WORKSPACE_FACTORIES: Record<string, WorkspaceToolFactory> = {
  write_file: writeFileTool,
  edit_file: editFileTool,
  patch_file: patchFileTool,
  delete_file: deleteFileTool,
  move_file: moveFileTool,
  create_directory: createDirectoryTool,
  delete_directory: deleteDirectoryTool,
  run_command: runCommandTool,
  update_project_notes: updateProjectNotesTool
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
  update_plan_step: updatePlanStepTool
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

  if (ctx.workspaceRoot) {
    const workspaceCtx: WorkspaceToolContext = { ...ctx, workspaceRoot: ctx.workspaceRoot }
    for (const [name, factory] of Object.entries(READ_ONLY_WORKSPACE_FACTORIES)) {
      tools[name] = factory(define, workspaceCtx)
    }
    if (ctx.projectId) {
      for (const [name, factory] of Object.entries(PROJECT_WORKSPACE_FACTORIES)) {
        tools[name] = factory(define, workspaceCtx)
      }
    }
  }

  for (const [name, factory] of Object.entries(GLOBAL_FACTORIES)) {
    tools[name] = factory(define, ctx)
  }

  if (ctx.webSearch.provider !== 'none') {
    tools.web_search = webSearchTool(define, ctx)
  }

  // Available in every chat, project or not — see the comment on
  // `PROJECT_WORKSPACE_FACTORIES` above. Disappears entirely only when both
  // memory scopes are turned off.
  if (ctx.memory.crossChatEnabled || ctx.memory.personalEnabled) {
    tools.remember_fact = rememberFactTool(define, ctx)
  }

  return tools
}
