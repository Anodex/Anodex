import { describe, expect, it } from 'vitest'
import { TOOL_CATALOG } from '@shared/tools.types'
import type { EmailSettings } from '@shared/settings.types'
import { buildTools } from '../registry'
import { createVisualInputQueue } from '../../vision/imageInputs'
import { computerControlService } from '../../computerControl/ComputerControlService'
import { createMockContext, createMockDefine } from './test-helpers'

function linkedGmail(): EmailSettings {
  return {
    accounts: [
      {
        id: 'account-1',
        provider: 'gmail',
        address: 'user@gmail.com',
        displayName: 'user@gmail.com',
        authKind: 'oauth',
        syncMode: 'metadata',
        createdAt: 0
      }
    ],
    primaryAccountId: 'account-1',
    sendRequiresApproval: true
  }
}

const PROJECT_WORKSPACE_TOOLS = [
  'write_file',
  'append_file',
  'edit_file',
  'replace_lines',
  'patch_file',
  'delete_file',
  'move_file',
  'create_directory',
  'delete_directory',
  'run_command',
  'run_project_check',
  'update_project_notes',
  'propose_change',
  'update_change_task',
  'archive_change',
  'list_changes'
]

const READ_ONLY_WORKSPACE_TOOLS = [
  'list_directory',
  'read_file',
  'search_files',
  'find_files',
  'get_file_info',
  'read_file_range',
  'read_multiple_files',
  'preview_html',
  'show_image',
  'code_outline',
  'git_status',
  'git_diff',
  'git_commit_summary'
]

const GLOBAL_OR_CONDITIONAL_TOOLS = [
  'anodex_status',
  'fetch_url',
  'web_search',
  'generate_image',
  'write_plan',
  'update_plan_step',
  'find_skill',
  'load_skill',
  'schedule_task',
  'delete_scheduled_task',
  'remember_fact',
  'list_email_accounts',
  'list_threads',
  'search_email',
  'read_email',
  'read_email_attachment',
  'draft_email',
  'save_email_draft',
  'send_email',
  'reply_email',
  'forward_email',
  'summarize_thread',
  'find_attachments',
  'list_mailboxes',
  'manage_email',
  'move_email',
  'batch_email'
]

const EMAIL_WORKSPACE_TOOLS = ['save_email_attachment']
const VISUAL_WORKSPACE_TOOLS = ['inspect_visual']
const SESSION_VISUAL_WORKSPACE_TOOLS = ['computer_control']
/** Needs a vision-capable provider and a linked account, but no workspace. */
const EMAIL_VISUAL_TOOLS = ['view_email_attachment']

/** Read-only, but project-gated (see `PROJECT_READ_ONLY_FACTORIES` in registry.ts). */
const PROJECT_READ_ONLY_TOOLS = ['search_code']

describe('buildTools', () => {
  it('registers only read-only workspace tools when no project is open', () => {
    const ctx = { ...createMockContext('/workspace'), projectId: null }
    const tools = buildTools(createMockDefine(), ctx)

    for (const name of READ_ONLY_WORKSPACE_TOOLS) expect(tools).toHaveProperty(name)
    for (const name of PROJECT_WORKSPACE_TOOLS) expect(tools).not.toHaveProperty(name)
    for (const name of PROJECT_READ_ONLY_TOOLS) expect(tools).not.toHaveProperty(name)
  })

  it('registers project-workspace tools too once a project is open', () => {
    const ctx = { ...createMockContext('/workspace'), projectId: 'project-1' }
    const tools = buildTools(createMockDefine(), ctx)

    for (const name of READ_ONLY_WORKSPACE_TOOLS) expect(tools).toHaveProperty(name)
    for (const name of PROJECT_WORKSPACE_TOOLS) expect(tools).toHaveProperty(name)
    for (const name of PROJECT_READ_ONLY_TOOLS) expect(tools).toHaveProperty(name)
  })

  it('registers visual inspection only when the active provider accepts tool images', () => {
    const withoutVision = createMockContext('/workspace')
    expect(buildTools(createMockDefine(), withoutVision)).not.toHaveProperty('inspect_visual')

    const withVision = {
      ...createMockContext('/workspace'),
      visualInputs: { current: [], acceptedCount: 0, limit: 4 }
    }
    expect(buildTools(createMockDefine(), withVision)).toHaveProperty('inspect_visual')
  })

  it('exposes computer control only to the visible interactive conversation, never a headless run', async () => {
    const conversationId = 'computer-control-visible-test'
    computerControlService.stopAll('user-stop')
    await computerControlService.start(conversationId, {
      describe: () => ({
        id: 'preview:test',
        scope: 'single-preview' as const,
        path: 'test.html',
        title: 'Test preview',
        width: 100,
        height: 100
      }),
      capture: () =>
        Promise.resolve({
          path: 'test.html',
          name: 'test.png',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,AA==',
          sizeBytes: 1
        }),
      execute: async () => {},
      isAlive: () => true,
      close: () => {}
    })
    try {
      const visible = {
        ...createMockContext('/workspace'),
        conversationId,
        visualInputs: createVisualInputQueue()
      }
      expect(buildTools(createMockDefine(), visible)).toHaveProperty('computer_control')

      const headless = { ...visible, enabledTools: new Set(['computer_control']) }
      expect(buildTools(createMockDefine(), headless)).not.toHaveProperty('computer_control')
    } finally {
      computerControlService.stopConversation(conversationId, 'user-stop')
    }
  })

  it('registers no workspace tools at all without a workspace root, project or not', () => {
    const ctx = { ...createMockContext('/workspace'), workspaceRoot: null, projectId: 'project-1' }
    const tools = buildTools(createMockDefine(), ctx)

    for (const name of [...READ_ONLY_WORKSPACE_TOOLS, ...PROJECT_WORKSPACE_TOOLS]) {
      expect(tools).not.toHaveProperty(name)
    }
  })

  it('registers image generation only for a provider that explicitly supports it', () => {
    const unsupported = createMockContext('/workspace')
    expect(buildTools(createMockDefine(), unsupported)).not.toHaveProperty('generate_image')

    const supported = { ...unsupported, imageGeneration: { provider: 'openai' as const } }
    expect(buildTools(createMockDefine(), supported)).toHaveProperty('generate_image')
  })

  it('registers find_skill and load_skill even in a plain general chat with no workspace', () => {
    const ctx = { ...createMockContext('/workspace'), workspaceRoot: null, projectId: null }
    const tools = buildTools(createMockDefine(), ctx)

    expect(tools).toHaveProperty('find_skill')
    expect(tools).toHaveProperty('load_skill')
  })

  it('registers remember_fact even in a plain general chat with no workspace or project', () => {
    // The bug this guards against: remember_fact used to require an open
    // project, so a casual "my name is X" in a general chat had nowhere to
    // go. It must be available regardless of workspace/project state.
    const ctx = { ...createMockContext('/workspace'), workspaceRoot: null, projectId: null }
    const tools = buildTools(createMockDefine(), ctx)

    expect(tools).toHaveProperty('remember_fact')
  })

  it('keeps remember_fact when only cross-chat memory is on', () => {
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: 'project-1',
      memory: { crossChatEnabled: true, personalEnabled: false, confirmBeforeSaving: false }
    }
    const tools = buildTools(createMockDefine(), ctx)

    expect(tools).toHaveProperty('remember_fact')
  })

  it('keeps remember_fact when only personal memory is on', () => {
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: null,
      memory: { crossChatEnabled: false, personalEnabled: true, confirmBeforeSaving: false }
    }
    const tools = buildTools(createMockDefine(), ctx)

    expect(tools).toHaveProperty('remember_fact')
  })

  it('omits remember_fact only when both memory scopes are off, keeping other project tools', () => {
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: 'project-1',
      memory: { crossChatEnabled: false, personalEnabled: false, confirmBeforeSaving: false }
    }
    const tools = buildTools(createMockDefine(), ctx)

    expect(tools).not.toHaveProperty('remember_fact')
    expect(tools).toHaveProperty('update_project_notes')
  })

  it('never registers finish_goal in an unrestricted (interactive chat) generation', () => {
    const ctx = { ...createMockContext('/workspace'), enabledTools: null }
    const tools = buildTools(createMockDefine(), ctx)

    expect(tools).not.toHaveProperty('finish_goal')
  })

  /**
   * A chat goal run (`/goal`) needs the *whole* toolset plus `finish_goal`.
   * Expressing that through a restricted `enabledTools` set would mean listing
   * every tool by name and quietly dropping new ones as they are added, so
   * `goalRun` is a separate switch.
   */
  it('registers finish_goal for a chat goal run without restricting the toolset', () => {
    const ctx = { ...createMockContext('/workspace'), enabledTools: null, goalRun: true }
    const tools = buildTools(createMockDefine(), ctx)

    expect(tools).toHaveProperty('finish_goal')
    // Still unrestricted — ordinary chat tools are present alongside it, which
    // a restricted `enabledTools` set would have had to enumerate.
    expect(tools).toHaveProperty('read_file')
    expect(tools).toHaveProperty('list_directory')
  })

  it('registers finish_goal only for a restricted run that explicitly opts into it', () => {
    const withoutIt = {
      ...createMockContext('/workspace'),
      enabledTools: new Set(['read_file'])
    }
    expect(buildTools(createMockDefine(), withoutIt)).not.toHaveProperty('finish_goal')

    const withIt = {
      ...createMockContext('/workspace'),
      enabledTools: new Set(['read_file', 'finish_goal'])
    }
    expect(buildTools(createMockDefine(), withIt)).toHaveProperty('finish_goal')
  })

  it('restricts registration to only the tools named in enabledTools', () => {
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: 'project-1',
      webSearch: { ...createMockContext('/workspace').webSearch, provider: 'brave' as const },
      enabledTools: new Set(['read_file', 'web_search'])
    }
    const tools = buildTools(createMockDefine(), ctx)

    expect(tools).toHaveProperty('read_file')
    expect(tools).toHaveProperty('web_search')
    expect(tools).not.toHaveProperty('write_file')
    expect(tools).not.toHaveProperty('list_directory')
    expect(tools).not.toHaveProperty('remember_fact')
    expect(tools).not.toHaveProperty('find_skill')
    expect(tools).not.toHaveProperty('load_skill')
  })

  it('registers every allowed tool when enabledTools is null (normal chat)', () => {
    const ctx = { ...createMockContext('/workspace'), projectId: 'project-1', enabledTools: null }
    const tools = buildTools(createMockDefine(), ctx)

    for (const name of [...READ_ONLY_WORKSPACE_TOOLS, ...PROJECT_WORKSPACE_TOOLS]) {
      expect(tools).toHaveProperty(name)
    }
  })

  it('omits user-disabled tools from a normal chat', () => {
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: 'project-1',
      disabledTools: new Set(['run_command', 'web_search'])
    }
    ctx.webSearch.provider = 'brave'

    const tools = buildTools(createMockDefine(), ctx)

    expect(tools).not.toHaveProperty('run_command')
    expect(tools).not.toHaveProperty('web_search')
    expect(tools).toHaveProperty('read_file')
  })

  it('registers email tools when Gmail is enabled', () => {
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: 'project-1',
      email: {
        accounts: [
          {
            id: 'account-1',
            provider: 'gmail' as const,
            address: 'user@gmail.com',
            displayName: 'user@gmail.com',
            authKind: 'oauth' as const,
            syncMode: 'metadata' as const,
            createdAt: 0
          }
        ],
        primaryAccountId: 'account-1',
        sendRequiresApproval: true as const
      }
    }
    const tools = buildTools(createMockDefine(), ctx)

    for (const name of [
      'list_email_accounts',
      'list_threads',
      'search_email',
      'read_email',
      'draft_email',
      'send_email',
      'reply_email',
      'summarize_thread',
      'find_attachments',
      'list_mailboxes',
      'manage_email',
      'move_email',
      'save_email_attachment'
    ]) {
      expect(tools).toHaveProperty(name)
    }
  })

  it('registers email tools for a non-Gmail account, not just Gmail', () => {
    // The gate is "any account is linked", so an IMAP-only user gets the same
    // tool surface — the tools resolve the provider themselves.
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: 'project-1',
      email: {
        accounts: [
          {
            id: 'account-imap',
            provider: 'imap' as const,
            address: 'person@fastmail.com',
            displayName: 'person@fastmail.com',
            authKind: 'password' as const,
            syncMode: 'metadata' as const,
            createdAt: 0
          }
        ],
        primaryAccountId: 'account-imap',
        sendRequiresApproval: true as const
      }
    }

    const tools = buildTools(createMockDefine(), ctx)

    expect(tools).toHaveProperty('list_threads')
    expect(tools).toHaveProperty('reply_email')
  })

  it('registers view_email_attachment with no workspace, given vision and an account', () => {
    // The case this tool exists for: the Email page's assistant rail, where
    // there is a linked mailbox and no project folder at all. Gating it like
    // the other visual tools would have made it unavailable exactly there.
    const ctx = {
      ...createMockContext('/workspace'),
      workspaceRoot: null,
      projectId: null,
      visualInputs: createVisualInputQueue(),
      email: linkedGmail()
    }

    const tools = buildTools(createMockDefine(), ctx)

    expect(tools).toHaveProperty('view_email_attachment')
    expect(tools).not.toHaveProperty('inspect_visual')
    expect(tools).not.toHaveProperty('save_email_attachment')
  })

  it('omits view_email_attachment when the model cannot see images', () => {
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: 'project-1',
      visualInputs: undefined,
      email: linkedGmail()
    }

    const tools = buildTools(createMockDefine(), ctx)

    expect(tools).toHaveProperty('find_attachments')
    expect(tools).not.toHaveProperty('view_email_attachment')
  })

  it('omits view_email_attachment when no account is linked, vision or not', () => {
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: 'project-1',
      visualInputs: createVisualInputQueue(),
      email: { accounts: [], primaryAccountId: null, sendRequiresApproval: true as const }
    }

    const tools = buildTools(createMockDefine(), ctx)

    expect(tools).not.toHaveProperty('view_email_attachment')
  })

  it('registers no email tools when nothing is linked', () => {
    const ctx = {
      ...createMockContext('/workspace'),
      projectId: 'project-1',
      email: { accounts: [], primaryAccountId: null, sendRequiresApproval: true as const }
    }

    const tools = buildTools(createMockDefine(), ctx)

    expect(tools).not.toHaveProperty('list_threads')
    expect(tools).not.toHaveProperty('send_email')
  })

  it('keeps the Settings tool catalog in sync with registered tool names', () => {
    const catalogNames = new Set(TOOL_CATALOG.map((tool) => tool.name))
    const registeredNames = new Set([
      ...READ_ONLY_WORKSPACE_TOOLS,
      ...PROJECT_WORKSPACE_TOOLS,
      ...EMAIL_WORKSPACE_TOOLS,
      ...VISUAL_WORKSPACE_TOOLS,
      ...SESSION_VISUAL_WORKSPACE_TOOLS,
      ...EMAIL_VISUAL_TOOLS,
      ...PROJECT_READ_ONLY_TOOLS,
      ...GLOBAL_OR_CONDITIONAL_TOOLS
    ])

    for (const name of registeredNames) {
      expect(catalogNames).toContain(name)
    }
    expect([...catalogNames].sort()).toEqual([...registeredNames].sort())
    expect(TOOL_CATALOG.every((tool) => tool.description.trim().length > 0)).toBe(true)
  })

  it('flags requiresProject on the catalog exactly for tools gated behind workspaceRoot/projectId', () => {
    const requiresProjectNames = new Set([
      ...READ_ONLY_WORKSPACE_TOOLS,
      ...PROJECT_WORKSPACE_TOOLS,
      ...EMAIL_WORKSPACE_TOOLS,
      ...VISUAL_WORKSPACE_TOOLS,
      ...SESSION_VISUAL_WORKSPACE_TOOLS,
      ...PROJECT_READ_ONLY_TOOLS
    ])

    for (const tool of TOOL_CATALOG) {
      expect(Boolean(tool.requiresProject)).toBe(requiresProjectNames.has(tool.name))
    }
  })
})
