import { describe, expect, it, vi } from 'vitest'
import type { DefineChatSessionFunction, ToolFunction } from '../../tools/types'
import { boundToolSurface, rankToolNames } from '../toolSurface'

function define(config: unknown): ToolFunction {
  return config as ToolFunction
}

function tool(description: string, handler = vi.fn(() => Promise.resolve('ok'))): ToolFunction {
  return {
    description,
    params: { type: 'object', properties: {} },
    handler
  }
}

const fakeDefine = define as DefineChatSessionFunction
const fixedCost = (functions: Record<string, ToolFunction> | undefined): number =>
  Object.keys(functions ?? {}).length * 100

describe('bounded tool surface', () => {
  it('keeps the full native surface when it fits', () => {
    const allFunctions = {
      read_file: tool('Read a file.'),
      send_email: tool('Send an email.')
    }

    const result = boundToolSurface({
      allFunctions,
      define: fakeDefine,
      routingText: 'read the source file',
      targetFixedTokens: 1_000,
      measureFixedTokens: fixedCost
    })

    expect(result.routed).toBe(false)
    expect(result.functions).toBe(allFunctions)
    expect(result.deferredToolNames).toEqual([])
  })

  it('keeps task-relevant tools native and leaves unrelated tools callable on demand', async () => {
    const sendEmail = vi.fn(() => Promise.resolve('sent'))
    const allFunctions = {
      send_email: tool('Send an email.', sendEmail),
      read_file: tool('Read a TypeScript file.'),
      list_directory: tool('List project source directories.'),
      web_search: tool('Search the public web.'),
      remember_fact: tool('Save a personal memory.'),
      draft_email: tool('Draft an email.')
    }

    // Three gateway schemas plus room for the two most relevant audit tools.
    const result = boundToolSurface({
      allFunctions,
      define: fakeDefine,
      routingText: 'Perform a read-only architectural audit of TypeScript project files.',
      targetFixedTokens: 500,
      measureFixedTokens: fixedCost
    })

    expect(result.routed).toBe(true)
    expect(result.directToolNames).toEqual(expect.arrayContaining(['read_file', 'list_directory']))
    expect(result.deferredToolNames).toContain('send_email')
    expect(result.functions).toHaveProperty('find_available_tool')
    expect(result.functions).toHaveProperty('describe_available_tool')
    expect(result.functions).toHaveProperty('call_available_tool')

    const found: unknown = await result.functions.find_available_tool.handler({ query: 'email' })
    expect(String(found)).toContain('send_email')

    const described: unknown = await result.functions.describe_available_tool.handler({
      name: 'send_email'
    })
    expect(String(described)).toContain('Send an email.')

    await result.functions.call_available_tool.handler({
      name: 'send_email',
      argumentsJson: '{"to":"person@example.com"}'
    })
    expect(sendEmail).toHaveBeenCalledWith({ to: 'person@example.com' })
  })

  it('caps native schemas even when more would fit the token target', () => {
    const allFunctions = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `read_tool_${index}`,
        tool(`Read project data ${index}.`)
      ])
    )
    const result = boundToolSurface({
      allFunctions,
      define: fakeDefine,
      routingText: 'Read the project architecture.',
      targetFixedTokens: 10_000,
      maxDirectTools: 8,
      measureFixedTokens: fixedCost
    })

    expect(result.routed).toBe(true)
    expect(result.directToolNames).toHaveLength(8)
    expect(result.deferredToolNames).toHaveLength(12)
  })

  it('rejects malformed deferred arguments before invoking the original tool', async () => {
    const handler = vi.fn(() => Promise.resolve('ok'))
    const result = boundToolSurface({
      allFunctions: {
        send_email: tool('Send an email.', handler),
        web_search: tool('Search the web.'),
        remember_fact: tool('Remember a fact.'),
        draft_email: tool('Draft an email.')
      },
      define: fakeDefine,
      routingText: 'unrelated request',
      targetFixedTokens: 300,
      measureFixedTokens: fixedCost
    })

    await expect(
      result.functions.call_available_tool.handler({
        name: 'send_email',
        argumentsJson: 'not json'
      })
    ).rejects.toThrow('valid JSON object')
    expect(handler).not.toHaveBeenCalled()
  })

  it('validates deferred arguments against the original required fields', async () => {
    const handler = vi.fn(() => Promise.resolve('ok'))
    const strictTool = {
      description: 'Read a file.',
      params: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      },
      handler
    } as ToolFunction
    const result = boundToolSurface({
      allFunctions: {
        read_file: strictTool,
        web_search: tool('Search the web.'),
        remember_fact: tool('Remember a fact.'),
        draft_email: tool('Draft an email.')
      },
      define: fakeDefine,
      routingText: 'unrelated request',
      targetFixedTokens: 300,
      measureFixedTokens: fixedCost
    })

    await expect(
      result.functions.call_available_tool.handler({
        name: 'read_file',
        argumentsJson: '{}'
      })
    ).rejects.toThrow('arguments.path is required')
    expect(handler).not.toHaveBeenCalled()
  })

  it('pages unusually large deferred schemas instead of returning a context-sized result', async () => {
    const largeTool = {
      description: 'x'.repeat(6_000),
      params: {
        type: 'object',
        properties: { query: { type: 'string', description: 'y'.repeat(6_000) } }
      },
      handler: vi.fn(() => Promise.resolve('ok'))
    } as ToolFunction
    const result = boundToolSurface({
      allFunctions: {
        large_mcp_tool: largeTool,
        web_search: tool('Search the web.'),
        remember_fact: tool('Remember a fact.'),
        draft_email: tool('Draft an email.')
      },
      define: fakeDefine,
      routingText: 'unrelated request',
      targetFixedTokens: 300,
      measureFixedTokens: fixedCost
    })

    const first: unknown = await result.functions.describe_available_tool.handler({
      name: 'large_mcp_tool'
    })
    expect(String(first).length).toBeLessThan(4_200)
    expect(String(first)).toContain('Request offset 4000 next.')

    const second: unknown = await result.functions.describe_available_tool.handler({
      name: 'large_mcp_tool',
      offset: 4_000
    })
    expect(String(second)).toContain('Schema chunk 4000-7999')
  })

  it('prioritizes the autonomous completion signal even when the prompt does not name it', () => {
    const ranked = rankToolNames(
      {
        read_file: tool('Read a file.'),
        finish_goal: tool('Finish the autonomous goal.')
      },
      'The work is complete.'
    )
    expect(ranked[0]).toBe('finish_goal')
  })

  it('does not rank write or command tools from negated read-only instructions', () => {
    const ranked = rankToolNames(
      {
        write_file: tool('Edit a project file.'),
        run_command: tool('Run a project command or test.'),
        read_file_range: tool('Read a range from a TypeScript file.'),
        list_directory: tool('List project source directories.')
      },
      'Perform a read-only architecture audit. Do not edit files or run commands.'
    )

    expect(ranked.slice(0, 2)).toEqual(
      expect.arrayContaining(['list_directory', 'read_file_range'])
    )
    expect(ranked.indexOf('write_file')).toBeGreaterThan(1)
    expect(ranked.indexOf('run_command')).toBeGreaterThan(1)
  })
})
