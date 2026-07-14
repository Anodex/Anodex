/** Types for the AI tool system: activity reporting and approval requests. */

import type { Plan } from './plan.types'

/** Category of a tool, used for icons and approval behaviour. */
export type ToolKind = 'read' | 'write' | 'command' | 'web' | 'plan'

/**
 * How risky a guarded tool call is, used by the permission system to decide
 * whether it runs automatically or needs the user's confirmation.
 * - trivial: no meaningful risk or data loss (e.g. creating a directory). Never
 *   confirmed, even in Ask mode — there's nothing to protect the user from.
 * - safe: a routine mutation (e.g. writing/editing a file). Confirmed in Ask mode.
 * - sensitive: harder to casually undo (e.g. deleting a file, most shell commands).
 * - destructive: broad or hard-to-reverse blast radius (e.g. `rm -rf`, force pushes).
 */
export type ToolRisk = 'trivial' | 'safe' | 'sensitive' | 'destructive'

export type ToolCallStatus = 'running' | 'success' | 'error' | 'denied'

/** A single tool invocation surfaced in the chat transcript. */
export interface ToolCall {
  id: string
  name: string
  kind: ToolKind
  /** Human-readable one-line summary, e.g. `Read src/index.ts`. */
  title: string
  /** Short result/status preview shown in the UI (not the full payload). */
  detail?: string
  /**
   * Truncated tool output, retained so the model can "remember" what it read or
   * ran when a conversation is resumed and its chat session is rebuilt.
   */
  result?: string
  status: ToolCallStatus
  /** Before/after content for a file write or edit, so the UI can render a diff. */
  diff?: ToolCallDiff
  /** Full snapshot of the conversation's plan after a `write_plan`/`update_plan_step` call. */
  plan?: Plan
  /** Optional rich preview rendered inside the chat transcript. */
  preview?: ToolCallPreview
  /**
   * Workspace-relative path(s) this call touched on success, same source as
   * `ProjectMemoryStore`'s file-touch ledger (see `helpers.ts`'s `recordTouch`)
   * — the authoritative list of what actually changed, as opposed to a path
   * parsed out of `title`/`diff` after the fact. Covers delete/move too,
   * which don't carry a `diff`.
   */
  touchedPaths?: string[]
}

export type ToolCallPreview = {
  kind: 'html'
  title: string
  path: string
  content: string
}

/** Full before/after content for a single file change, diffed for display. */
export interface ToolCallDiff {
  path: string
  before: string
  after: string
}

/** Emitted from a tool handler to update the UI as a call progresses. */
export interface ToolActivityEvent {
  conversationId: string
  messageId: string
  call: ToolCall
}

/** A request for the user to approve a write or command before it runs. */
export interface ToolConfirmRequest {
  id: string
  conversationId: string
  messageId: string
  toolName: string
  kind: 'write' | 'command' | 'web'
  /** Short title, e.g. `Run command`. */
  title: string
  /** The specifics: the command string or the target file + preview. */
  detail: string
  /** Why this call needs confirmation under the active permission mode. */
  risk: ToolRisk
  /** Before/after content for a file write/edit, so the prompt can render a real diff instead of a raw text preview. */
  diff?: ToolCallDiff
  /** True when this prompt exists specifically because of the untethered-mode
   * once-per-turn gate (not a normal risk-based confirm) — lets the UI explain
   * that approving covers the rest of this turn, not just this one action. */
  turnGate?: boolean
}

/** The user's answer to a `ToolConfirmRequest`. */
export interface ToolConfirmResponse {
  approved: boolean
  /** Approve and don't ask again for this exact tool name, for the rest of the app session.
   *  Ignored when `approved` is false. */
  remember?: boolean
  /** Optional free-text reason typed on denial, woven into the model-facing denial message. */
  reason?: string
}

/** Static metadata about the available tools, for the Settings UI. */
export interface ToolCatalogEntry {
  name: string
  kind: ToolKind
  description: string
  /** True if this tool only registers when a project (workspace folder) is open. */
  requiresProject?: boolean
}

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    name: 'list_directory',
    kind: 'read',
    description: 'List files and folders in the workspace.',
    requiresProject: true
  },
  {
    name: 'read_file',
    kind: 'read',
    description: 'Read the contents of a file.',
    requiresProject: true
  },
  {
    name: 'read_file_range',
    kind: 'read',
    description: 'Read a specific range of lines from a file.',
    requiresProject: true
  },
  {
    name: 'read_multiple_files',
    kind: 'read',
    description: 'Read several files in one call.',
    requiresProject: true
  },
  {
    name: 'preview_html',
    kind: 'read',
    description: 'Render an HTML file as an inline, sandboxed preview in chat.',
    requiresProject: true
  },
  {
    name: 'get_file_info',
    kind: 'read',
    description: 'Get metadata about a file or directory.',
    requiresProject: true
  },
  {
    name: 'search_files',
    kind: 'read',
    description: 'Search the workspace for text.',
    requiresProject: true
  },
  {
    name: 'find_files',
    kind: 'read',
    description: 'Find files and folders by path or name.',
    requiresProject: true
  },
  {
    name: 'code_outline',
    kind: 'read',
    description: 'Summarize imports and exported symbols for source files.',
    requiresProject: true
  },
  {
    name: 'git_status',
    kind: 'read',
    description: 'Show git status of the workspace.',
    requiresProject: true
  },
  {
    name: 'git_diff',
    kind: 'read',
    description: 'Show git diff of the workspace.',
    requiresProject: true
  },
  {
    name: 'git_commit_summary',
    kind: 'read',
    description: 'Summarize git changes and draft a conventional commit message.',
    requiresProject: true
  },
  {
    name: 'fetch_url',
    kind: 'web',
    description: 'Fetch a public URL and return its text content.'
  },
  {
    name: 'web_search',
    kind: 'web',
    description: 'Search the web using the configured provider.'
  },
  {
    name: 'write_file',
    kind: 'write',
    description: 'Create or overwrite a file (asks for approval). Requires an open project.',
    requiresProject: true
  },
  {
    name: 'edit_file',
    kind: 'write',
    description: 'Replace text within a file (asks for approval). Requires an open project.',
    requiresProject: true
  },
  {
    name: 'patch_file',
    kind: 'write',
    description:
      'Apply multiple exact replacements in one file (asks for approval). Requires an open project.',
    requiresProject: true
  },
  {
    name: 'delete_file',
    kind: 'write',
    description: 'Delete a file (asks for approval). Requires an open project.',
    requiresProject: true
  },
  {
    name: 'move_file',
    kind: 'write',
    description: 'Move or rename a file (asks for approval). Requires an open project.',
    requiresProject: true
  },
  {
    name: 'delete_directory',
    kind: 'write',
    description: 'Delete an empty directory (asks for approval). Requires an open project.',
    requiresProject: true
  },
  {
    name: 'create_directory',
    kind: 'write',
    description: 'Create a directory (no approval needed). Requires an open project.',
    requiresProject: true
  },
  {
    name: 'run_command',
    kind: 'command',
    description:
      'Run a shell command in the workspace (asks for approval). Requires an open project.',
    requiresProject: true
  },
  {
    name: 'run_project_check',
    kind: 'command',
    description:
      'Run test/typecheck/lint/build with structured pass/fail diagnostics (asks for approval). Requires an open project.',
    requiresProject: true
  },
  {
    name: 'write_plan',
    kind: 'plan',
    description: 'Create or replace the visible task plan for this conversation.'
  },
  {
    name: 'update_plan_step',
    kind: 'plan',
    description: 'Mark a plan step as in progress or completed.'
  },
  {
    name: 'find_skill',
    kind: 'read',
    description: 'Search the local skill catalog for reusable instructions.'
  },
  {
    name: 'load_skill',
    kind: 'read',
    description: "Load a skill's full instructions by name."
  },
  {
    name: 'update_project_notes',
    kind: 'write',
    description:
      'Record a durable note about this project into ANODEX.md (asks for approval). Requires an open project.',
    requiresProject: true
  },
  {
    name: 'remember_fact',
    kind: 'write',
    description:
      'Save a durable global or project memory when memory is enabled (asks for approval).'
  },
  {
    name: 'list_threads',
    kind: 'read',
    description: 'List recent email threads from the configured email provider.'
  },
  {
    name: 'search_email',
    kind: 'read',
    description: 'Search email threads by query.'
  },
  {
    name: 'read_email',
    kind: 'read',
    description: 'Read an email message by id.'
  },
  {
    name: 'draft_email',
    kind: 'read',
    description: 'Create a local email draft without sending it.'
  },
  {
    name: 'send_email',
    kind: 'write',
    description: 'Send an email, always requiring explicit approval.'
  },
  {
    name: 'summarize_thread',
    kind: 'read',
    description: 'Summarize an email thread by id.'
  },
  {
    name: 'find_attachments',
    kind: 'read',
    description: 'Find attachments in an email thread.'
  },
  {
    name: 'save_email_attachment',
    kind: 'write',
    description:
      'Save an email attachment into the current workspace (asks for approval). Requires an open project.',
    requiresProject: true
  }
]
