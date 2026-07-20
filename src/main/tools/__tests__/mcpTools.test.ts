import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { McpToolDescriptor } from '@shared/mcp.types'
import { buildMcpToolFunction } from '../mcpTools'
import type { ToolRuntimeContext } from '../types'
import {
  createMockContext,
  createMockDefine,
  captureCalls,
  captureConfirmations
} from './test-helpers'

const mocks = vi.hoisted(() => ({
  callTool:
    vi.fn<(serverId: string, toolName: string, args: Record<string, unknown>) => Promise<string>>()
}))

vi.mock('../../mcp/McpManager', () => ({
  mcpManager: { callTool: mocks.callTool }
}))

type McpHandler = (args: Record<string, unknown>) => Promise<string>

function descriptor(overrides: Partial<McpToolDescriptor> = {}): McpToolDescriptor {
  return {
    serverId: 'server-1',
    serverName: 'Linear',
    toolName: 'list_issues',
    qualifiedName: 'server-1__list_issues',
    description: 'List issues in a project.',
    inputSchema: { type: 'object', properties: {} },
    risk: 'safe',
    readOnly: true,
    forceConfirm: false,
    ...overrides
  }
}

describe('MCP tool wiring', () => {
  beforeEach(() => {
    mocks.callTool.mockReset()
  })

  it('runs a read-only MCP tool without requiring confirmation', async () => {
    mocks.callTool.mockResolvedValue('3 issues found.')
    const { confirm, requests } = captureConfirmations()
    const ctx: ToolRuntimeContext = { ...createMockContext('/tmp/workspace'), confirm }
    const fn = buildMcpToolFunction(
      createMockDefine(),
      ctx,
      descriptor({ readOnly: true })
    ) as unknown as { handler: McpHandler }

    const result = await fn.handler({ project: 'ENG' })

    expect(result).toBe('3 issues found.')
    expect(mocks.callTool).toHaveBeenCalledWith('server-1', 'list_issues', { project: 'ENG' })
    expect(requests).toHaveLength(0)
  })

  it('routes a non-read-only MCP tool through the guarded/confirm path', async () => {
    mocks.callTool.mockResolvedValue('Issue created.')
    const { confirm, requests } = captureConfirmations()
    const ctx: ToolRuntimeContext = {
      ...createMockContext('/tmp/workspace'),
      permissionMode: 'ask',
      confirm
    }
    const fn = buildMcpToolFunction(
      createMockDefine(),
      ctx,
      descriptor({ readOnly: false, toolName: 'create_issue', risk: 'sensitive' })
    ) as unknown as { handler: McpHandler }

    const result = await fn.handler({ title: 'Bug' })

    expect(result).toBe('Issue created.')
    expect(requests).toHaveLength(1)
    expect(requests[0].title).toContain('create_issue')
  })

  it('surfaces a failed MCP call as a model-facing error, not a rejected promise', async () => {
    mocks.callTool.mockRejectedValue(new Error('Server unreachable'))
    const { calls, emit } = captureCalls()
    const ctx: ToolRuntimeContext = { ...createMockContext('/tmp/workspace'), emit }
    const fn = buildMcpToolFunction(
      createMockDefine(),
      ctx,
      descriptor({ readOnly: true })
    ) as unknown as { handler: McpHandler }

    const result = await fn.handler({})

    expect(result).toContain('Server unreachable')
    expect(calls.at(-1)?.status).toBe('error')
  })

  it('labels the tool description with the originating MCP server', () => {
    const fn = buildMcpToolFunction(
      createMockDefine(),
      createMockContext('/tmp/workspace'),
      descriptor({ serverName: 'Linear', description: 'List issues.' })
    ) as unknown as { description: string }

    expect(fn.description).toBe('[MCP: Linear] List issues.')
  })

  it('falls back to a generic description when the server provides none', () => {
    const fn = buildMcpToolFunction(
      createMockDefine(),
      createMockContext('/tmp/workspace'),
      descriptor({ toolName: 'list_issues', description: '' })
    ) as unknown as { description: string }

    expect(fn.description).toContain('Call the "list_issues" tool.')
  })
})
