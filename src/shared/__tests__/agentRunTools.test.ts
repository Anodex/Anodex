import { describe, expect, it } from 'vitest'
import { buildRunToolNames, readOnlyRunToolNames, TOOL_CATALOG } from '../tools.types'

/**
 * The default used to be `['fetch_url', 'web_search']`. In a feature described
 * as "hand off a goal and Anodex works it unattended", a run started on the
 * defaults could not read a file, edit one, or run a command.
 */
describe('buildRunToolNames', () => {
  const build = new Set(buildRunToolNames())

  it('can actually build: read, change, run and plan', () => {
    for (const name of [
      'list_directory',
      'read_file',
      'search_files',
      'write_file',
      'edit_file',
      'replace_lines',
      'run_command',
      'write_plan'
    ]) {
      expect(build.has(name)).toBe(true)
    }
  })

  /** An unattended run has nobody to catch a wrong path. */
  it('leaves destructive file operations off by default', () => {
    for (const name of ['delete_file', 'delete_directory', 'move_file']) {
      expect(build.has(name)).toBe(false)
    }
  })

  it('does not sweep in somebody else’s job', () => {
    for (const name of TOOL_CATALOG.map((tool) => tool.name)) {
      if (/email|thread|mailbox|attachment/i.test(name)) expect(build.has(name)).toBe(false)
    }
    expect(build.has('schedule_task')).toBe(false)
    expect(build.has('generate_image')).toBe(false)
  })

  /** Ticking one would only ever be refused mid-run. */
  it('never offers a tool that needs a person to approve it', () => {
    const approvalOnly = TOOL_CATALOG.filter((tool) => tool.requiresHumanApproval).map(
      (t) => t.name
    )
    for (const name of approvalOnly) expect(build.has(name)).toBe(false)
    for (const name of readOnlyRunToolNames()) expect(approvalOnly).not.toContain(name)
  })
})

describe('readOnlyRunToolNames', () => {
  it('looks but never changes anything', () => {
    const readOnly = new Set(readOnlyRunToolNames())
    expect(readOnly.has('read_file')).toBe(true)
    expect(readOnly.has('search_files')).toBe(true)
    for (const name of ['write_file', 'edit_file', 'replace_lines', 'run_command']) {
      expect(readOnly.has(name)).toBe(false)
    }
  })
})
