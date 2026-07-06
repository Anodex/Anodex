import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolConfirmRequest } from '@shared/tools.types'
import { runCommandTool } from '../commandTools'
import { createMockContext, createMockDefine } from './test-helpers'

describe('run_command', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'anodex-command-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('runs a command and reports its exit code and output', async () => {
    const ctx = {
      ...createMockContext(workspace),
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string }) => Promise<string>
    }

    const result = await tool.handler({ command: 'echo hello' })

    expect(result).toContain('Exit code 0')
    expect(result).toContain('hello')
  })

  it('reports a non-zero exit code without throwing', async () => {
    const ctx = {
      ...createMockContext(workspace),
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string }) => Promise<string>
    }

    const result = await tool.handler({ command: 'exit 3' })

    expect(result).toContain('Exit code 3')
  })

  it('runs the command inside the workspace directory', async () => {
    const ctx = {
      ...createMockContext(workspace),
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string }) => Promise<string>
    }

    // `cd` with no output proves nothing; print the cwd instead so the test
    // actually asserts the command ran scoped to the workspace, not just that
    // some command ran somewhere.
    const result = await tool.handler({ command: process.platform === 'win32' ? 'cd' : 'pwd' })

    expect(result.replace(/\\/g, '/')).toContain(workspace.replace(/\\/g, '/'))
  })

  it('truncates very large command output', async () => {
    const ctx = {
      ...createMockContext(workspace),
      confirm: () => Promise.resolve({ approved: true })
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string }) => Promise<string>
    }

    // A command that prints far more than the shared 4000-char model-result
    // cap — the "large output" analog of the large-file tests for the read
    // tools. Also guards against the same double-truncation bug found in
    // read_file: the note must report the command's real total output
    // length, not some other, meaningless intermediate length.
    const command =
      process.platform === 'win32'
        ? 'for /L %i in (1,1,3000) do @echo line%i'
        : 'for i in $(seq 1 3000); do echo line$i; done'
    const result = await tool.handler({ command })

    expect(result.length).toBeLessThan(4100)
    expect(result).toMatch(/truncated, \d+ bytes total/)
  })

  it('asks for confirmation before running, and honours a denial', async () => {
    const requests: ToolConfirmRequest[] = []
    const ctx = {
      ...createMockContext(workspace),
      confirm: (request: ToolConfirmRequest) => {
        requests.push(request)
        return Promise.resolve({ approved: false })
      }
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string }) => Promise<string>
    }

    const result = await tool.handler({ command: 'echo should-not-run' })

    expect(requests).toHaveLength(1)
    expect(result).toContain('denied')
  })

  it('classifies an obviously destructive command with the destructive risk badge', async () => {
    const requests: ToolConfirmRequest[] = []
    const ctx = {
      ...createMockContext(workspace),
      confirm: (request: ToolConfirmRequest) => {
        requests.push(request)
        return Promise.resolve({ approved: false })
      }
    }
    const tool = runCommandTool(createMockDefine(), ctx) as unknown as {
      handler: (args: { command: string }) => Promise<string>
    }

    await tool.handler({ command: 'rm -rf /' })

    expect(requests[0]?.risk).toBe('destructive')
  })
})
