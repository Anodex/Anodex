import { describe, expect, it } from 'vitest'
import { TOOL_CATALOG } from '@shared/tools.types'
import { buildTools } from '../registry'
import { createMockContext, createMockDefine } from './test-helpers'

const PROJECT_WORKSPACE_TOOLS = [
  'write_file',
  'edit_file',
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
  'code_outline',
  'git_status',
  'git_diff',
  'git_commit_summary'
]

const GLOBAL_OR_CONDITIONAL_TOOLS = [
  'fetch_url',
  'web_search',
  'write_plan',
  'update_plan_step',
  'find_skill',
  'load_skill',
  'remember_fact',
  'list_threads',
  'search_email',
  'read_email',
  'draft_email',
  'send_email',
  'summarize_thread',
  'find_attachments'
]

const EMAIL_WORKSPACE_TOOLS = ['save_email_attachment']

describe('buildTools', () => {
  it('registers only read-only workspace tools when no project is open', () => {
    const ctx = { ...createMockContext('/workspace'), projectId: null }
    const tools = buildTools(createMockDefine(), ctx)

    for (const name of READ_ONLY_WORKSPACE_TOOLS) expect(tools).toHaveProperty(name)
    for (const name of PROJECT_WORKSPACE_TOOLS) expect(tools).not.toHaveProperty(name)
  })

  it('registers project-workspace tools too once a project is open', () => {
    const ctx = { ...createMockContext('/workspace'), projectId: 'project-1' }
    const tools = buildTools(createMockDefine(), ctx)

    for (const name of READ_ONLY_WORKSPACE_TOOLS) expect(tools).toHaveProperty(name)
    for (const name of PROJECT_WORKSPACE_TOOLS) expect(tools).toHaveProperty(name)
  })

  it('registers no workspace tools at all without a workspace root, project or not', () => {
    const ctx = { ...createMockContext('/workspace'), workspaceRoot: null, projectId: 'project-1' }
    const tools = buildTools(createMockDefine(), ctx)

    for (const name of [...READ_ONLY_WORKSPACE_TOOLS, ...PROJECT_WORKSPACE_TOOLS]) {
      expect(tools).not.toHaveProperty(name)
    }
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
        provider: 'gmail' as const,
        gmail: {
          enabled: true,
          address: 'user@gmail.com',
          oauthClientId: '',
          oauthClientSecret: '',
          syncMode: 'metadata' as const,
          sendRequiresApproval: true as const
        }
      }
    }
    const tools = buildTools(createMockDefine(), ctx)

    for (const name of [
      'list_threads',
      'search_email',
      'read_email',
      'draft_email',
      'send_email',
      'summarize_thread',
      'find_attachments',
      'save_email_attachment'
    ]) {
      expect(tools).toHaveProperty(name)
    }
  })

  it('keeps the Settings tool catalog in sync with registered tool names', () => {
    const catalogNames = new Set(TOOL_CATALOG.map((tool) => tool.name))

    for (const name of [
      ...READ_ONLY_WORKSPACE_TOOLS,
      ...PROJECT_WORKSPACE_TOOLS,
      ...EMAIL_WORKSPACE_TOOLS,
      ...GLOBAL_OR_CONDITIONAL_TOOLS
    ]) {
      expect(catalogNames).toContain(name)
    }
  })

  it('flags requiresProject on the catalog exactly for tools gated behind workspaceRoot/projectId', () => {
    const requiresProjectNames = new Set([
      ...READ_ONLY_WORKSPACE_TOOLS,
      ...PROJECT_WORKSPACE_TOOLS,
      ...EMAIL_WORKSPACE_TOOLS
    ])

    for (const tool of TOOL_CATALOG) {
      expect(Boolean(tool.requiresProject)).toBe(requiresProjectNames.has(tool.name))
    }
  })
})
