import { describe, expect, it } from 'vitest'
import { buildTools } from '../registry'
import { createMockContext, createMockDefine } from './test-helpers'

const MUTATING_TOOLS = [
  'write_file',
  'edit_file',
  'delete_file',
  'move_file',
  'create_directory',
  'delete_directory',
  'run_command',
  'update_project_notes'
]

const READ_ONLY_WORKSPACE_TOOLS = [
  'list_directory',
  'read_file',
  'search_files',
  'get_file_info',
  'read_file_range',
  'read_multiple_files',
  'git_status',
  'git_diff'
]

describe('buildTools', () => {
  it('registers only read-only workspace tools when no project is open', () => {
    const ctx = { ...createMockContext('/workspace'), projectId: null }
    const tools = buildTools(createMockDefine(), ctx)

    for (const name of READ_ONLY_WORKSPACE_TOOLS) expect(tools).toHaveProperty(name)
    for (const name of MUTATING_TOOLS) expect(tools).not.toHaveProperty(name)
  })

  it('registers mutating tools too once a project is open', () => {
    const ctx = { ...createMockContext('/workspace'), projectId: 'project-1' }
    const tools = buildTools(createMockDefine(), ctx)

    for (const name of READ_ONLY_WORKSPACE_TOOLS) expect(tools).toHaveProperty(name)
    for (const name of MUTATING_TOOLS) expect(tools).toHaveProperty(name)
  })

  it('registers no workspace tools at all without a workspace root, project or not', () => {
    const ctx = { ...createMockContext('/workspace'), workspaceRoot: null, projectId: 'project-1' }
    const tools = buildTools(createMockDefine(), ctx)

    for (const name of [...READ_ONLY_WORKSPACE_TOOLS, ...MUTATING_TOOLS]) {
      expect(tools).not.toHaveProperty(name)
    }
  })
})
