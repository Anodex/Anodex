/** Types for the AI tool system: activity reporting and approval requests. */

import type { Plan } from './plan.types'
import type { ComputerControlAuditEntry } from './computerControl.types'

/** Category of a tool, used for icons and approval behaviour. */
export type ToolKind = 'read' | 'write' | 'command' | 'web' | 'plan' | 'mcp'

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
  /**
   * Whether this successful call produced new durable information or changed
   * state. `false` is used for deliberately successful redirects/no-ops (for
   * example, a request for a file range already covered earlier in the same
   * bounded task). Absent means true for backward compatibility with older
   * persisted conversations.
   */
  madeProgress?: boolean
  /** Before/after content for a file write or edit, so the UI can render a diff. */
  diff?: ToolCallDiff
  /** Full snapshot of the conversation's plan after a `write_plan`/`update_plan_step` call. */
  plan?: Plan
  /** Optional rich preview rendered inside the chat transcript. */
  preview?: ToolCallPreview
  /** Durable audit metadata for a constrained computer-control action. */
  computerControl?: ComputerControlAuditEntry
  /**
   * Workspace-relative path(s) this call touched on success, same source as
   * `ProjectMemoryStore`'s file-touch ledger (see `helpers.ts`'s `recordTouch`)
   * — the authoritative list of what actually changed, as opposed to a path
   * parsed out of `title`/`diff` after the fact. Covers delete/move too,
   * which don't carry a `diff`.
   */
  touchedPaths?: string[]
}

export type ToolCallPreview =
  | {
      kind: 'html'
      title: string
      path: string
      content: string
    }
  | {
      /** Image bytes used immediately by the live transcript; never persisted in conversation JSON. */
      kind: 'image'
      /**
       * Where the pixels came from, which decides how they can be recovered
       * once the durable asset is gone: `inspection` and `email` were both sent
       * to the model but are re-fetched by different tools, and `assistant` was
       * deliberately shown only to the user.
       */
      source?: 'inspection' | 'assistant' | 'email' | 'generated'
      title: string
      path: string
      /** Original prompt, retained for a user-requested regeneration if this asset expires. */
      prompt?: string
      dataUrl?: string
      mimeType: string
      /** Durable, sandboxed reference used to reopen the exact inspected pixels later. */
      asset?: VisualPreviewAssetRef
      /** Additional viewport captures belonging to one multi-section visual inspection. */
      sections?: VisualPreviewSection[]
    }

/** A separately stored viewport capture from a single visual inspection. */
export interface VisualPreviewSection {
  title: string
  dataUrl?: string
  mimeType: string
  asset?: VisualPreviewAssetRef
}

export interface VisualPreviewAssetRef {
  conversationId: string
  id: string
}

export interface VisualPreviewContent {
  dataUrl: string
  mimeType: string
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
/**
 * An outgoing email as the approval prompt should show it.
 *
 * Deliberately the resolved message, not the model's arguments: a reply's
 * recipients and subject come from the message being answered, and a send from
 * a saved draft ignores whatever the model passed alongside the draft id. The
 * user has to approve what will actually leave the machine.
 */
export interface EmailDraftPreview {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
  attachmentNames?: string[]
  /** Subject of the message being answered, when this is a reply. */
  inReplyToSubject?: string
}

export interface ToolConfirmRequest {
  id: string
  conversationId: string
  messageId: string
  toolName: string
  kind: 'write' | 'command' | 'web' | 'mcp'
  /** Short title, e.g. `Run command`. */
  title: string
  /** The specifics: the command string or the target file + preview. */
  detail: string
  /** Why this call needs confirmation under the active permission mode. */
  risk: ToolRisk
  /** Before/after content for a file write/edit, so the prompt can render a real diff instead of a raw text preview. */
  diff?: ToolCallDiff
  /**
   * The message an email tool is about to send, when this prompt is gating
   * one. Present so the approval can be rendered as the draft it is —
   * recipients, subject, and body as prose — rather than as a block of
   * pre-formatted detail text the reader has to parse before deciding.
   */
  emailDraft?: EmailDraftPreview
  /** True when this prompt exists specifically because of the once-per-turn
   * "first action" gate (full/untethered mode, not a normal risk-based
   * confirm) — lets the UI explain that approving covers the rest of this
   * turn, not just this one action. */
  turnGate?: boolean
  /**
   * True when a real person must answer this prompt — see
   * `ToolCatalogEntry.requiresHumanApproval`. Carried on the request so the
   * headless confirm handlers the unattended surfaces install
   * (`headlessConfirm`) can refuse it without knowing which tools those are.
   */
  requiresHumanApproval?: boolean
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
  /**
   * True if this tool may only ever run with a person present to approve the
   * specific call. Unlike a risk tier, this is not something a permission mode
   * can relax: `untethered` still confirms it, and the unattended surfaces
   * (scheduled tasks, agent runs, critical-thinking research) refuse it rather
   * than auto-approving, because their headless `confirm` is not a human
   * saying yes. Set on the tools that reach outside the machine on the user's
   * behalf and cannot be taken back — sending mail.
   */
  requiresHumanApproval?: boolean
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
    description:
      'Render interactive HTML inline; for before/after screenshots use inspect_visual on the same path instead, editing the file in place between captures.',
    requiresProject: true
  },
  {
    name: 'inspect_visual',
    kind: 'read',
    description:
      'Capture a workspace image or up to three primary HTML sections; pass a section id to inspect one named page section precisely. To compare, inspect the same path, edit that file in place, then inspect it again — never rename or copy it to make a "before".',
    requiresProject: true
  },
  {
    name: 'computer_control',
    kind: 'read',
    description:
      'Use one typed action in a user-enabled, visible AI-control session. Available only to an active vision chat for its selected Anodex surface, preview, or approved desktop window; successful actions return an audited screenshot.',
    requiresProject: true
  },
  {
    name: 'show_image',
    kind: 'read',
    description: 'Display an existing workspace image directly in the assistant reply.',
    requiresProject: true
  },
  {
    name: 'generate_image',
    kind: 'web',
    description:
      'Generate one image with the active supported cloud provider. Always requires explicit approval because it sends the prompt to a paid external image API.'
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
    description: 'Summarize imports and exported symbols for JavaScript/TypeScript files.',
    requiresProject: true
  },
  {
    name: 'search_code',
    kind: 'read',
    description: 'Search the workspace by meaning, not exact text.',
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
    description: 'Fetch a public URL and return bounded readable passages plus a source artifact.'
  },
  {
    name: 'web_search',
    kind: 'web',
    description: 'Search the web using the configured provider.'
  },
  {
    name: 'write_file',
    kind: 'write',
    description:
      'Create or overwrite a file. Approval depends on permission mode. Requires an open project.',
    requiresProject: true
  },
  {
    name: 'append_file',
    kind: 'write',
    description:
      'Append a short text chunk to an existing file. Use for long files after write_file. Approval depends on permission mode. Requires an open project.',
    requiresProject: true
  },
  {
    name: 'edit_file',
    kind: 'write',
    description:
      'Replace exact unique text within a file. Approval depends on permission mode. Requires an open project.',
    requiresProject: true
  },
  {
    name: 'patch_file',
    kind: 'write',
    description:
      'Apply multiple exact replacements in one file. Approval depends on permission mode. Requires an open project.',
    requiresProject: true
  },
  {
    name: 'delete_file',
    kind: 'write',
    description:
      'Delete a file. Approval depends on permission mode and risk. Requires an open project.',
    requiresProject: true
  },
  {
    name: 'move_file',
    kind: 'write',
    description:
      'Move or rename a file. Approval depends on permission mode. Requires an open project.',
    requiresProject: true
  },
  {
    name: 'delete_directory',
    kind: 'write',
    description:
      'Delete an empty directory, never the workspace root. Approval depends on permission mode. Requires an open project.',
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
      'Run a real local shell starting in the workspace; it is not workspace-confined. Approval depends on permission mode and risk. Requires an open project.',
    requiresProject: true
  },
  {
    name: 'run_project_check',
    kind: 'command',
    description:
      'Run test/typecheck/lint/build or a custom command with structured diagnostics. Approval depends on permission mode and risk. Requires an open project.',
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
    name: 'schedule_task',
    kind: 'write',
    description:
      'Create a Scheduler task that runs a prompt later, once or on a repeat. Always confirmed before saving.'
  },
  {
    name: 'update_project_notes',
    kind: 'write',
    description:
      'Record a durable note in ANODEX.md. Approval depends on permission mode. Requires an open project.',
    requiresProject: true
  },
  {
    name: 'propose_change',
    kind: 'write',
    description:
      'Persist a change rationale and task checklist. Approval depends on permission mode. Requires an open project.',
    requiresProject: true
  },
  {
    name: 'update_change_task',
    kind: 'write',
    description:
      'Mark a persisted change task done or not done. Approval depends on permission mode. Requires an open project.',
    requiresProject: true
  },
  {
    name: 'archive_change',
    kind: 'write',
    description:
      'Archive a finished change into the project’s living spec. Approval depends on permission mode. Requires an open project.',
    requiresProject: true
  },
  {
    name: 'list_changes',
    kind: 'read',
    description: "List this project's active change proposals. Requires an open project.",
    requiresProject: true
  },
  {
    name: 'remember_fact',
    kind: 'write',
    description:
      'Save durable global or project memory. Approval depends on memory settings and permission mode.'
  },
  {
    name: 'list_email_accounts',
    kind: 'read',
    description: 'List the linked email accounts and which one is the default.'
  },
  {
    name: 'list_threads',
    kind: 'read',
    description: 'List recent email threads from a linked email account.'
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
    name: 'save_email_draft',
    kind: 'write',
    description:
      "Save a draft into the account's Drafts folder for the user to finish. Sends nothing."
  },
  {
    name: 'send_email',
    kind: 'write',
    description: 'Send an email, always requiring explicit approval.',
    requiresHumanApproval: true
  },
  {
    name: 'forward_email',
    kind: 'write',
    description:
      'Forward a message to someone else with its attachments, always requiring explicit approval.',
    requiresHumanApproval: true
  },
  {
    name: 'batch_email',
    kind: 'write',
    description:
      'Apply one action (mark read, star, archive, move) to every thread matching a query. Cannot delete mail.'
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
    name: 'view_email_attachment',
    kind: 'read',
    description:
      'Look at the pixels of an image attached to an email. Only available when the active model can see images.'
  },
  {
    name: 'read_email_attachment',
    kind: 'read',
    description: 'Read the text of a PDF, CSV, JSON, or text attachment on an email.'
  },
  {
    name: 'list_mailboxes',
    kind: 'read',
    description: 'List the mailboxes, labels, or folders on an email account.'
  },
  {
    name: 'reply_email',
    kind: 'write',
    description:
      'Reply in-thread to an email message, always requiring explicit approval before sending.',
    requiresHumanApproval: true
  },
  {
    name: 'manage_email',
    kind: 'write',
    description:
      'Mark email read or unread, star, archive, or move it back to the inbox. Cannot delete mail.'
  },
  {
    name: 'move_email',
    kind: 'write',
    description: 'Move an email thread or message to another mailbox, label, or folder.'
  },
  {
    name: 'save_email_attachment',
    kind: 'write',
    description:
      'Save an email attachment into the workspace. Approval depends on permission mode. Requires an open project.',
    requiresProject: true
  }
]
