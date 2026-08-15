import { describe, expect, it, vi } from 'vitest'
import type { DefineChatSessionFunction, ToolFunction } from '../../tools/types'
import {
  boundToolSurface,
  GATEWAY_TOOL_COUNT,
  maxDirectToolsForContext,
  rankToolNames
} from '../toolSurface'

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

  /**
   * "Build a website ... lets build it in steps" reads as a change task but not
   * a code task (no "code"/"file"/"project" in it), which used to leave
   * `update_plan_step` scoring 0 while the confusingly similar
   * `update_change_task` scored 3_500 off the write-tool bucket.
   */
  it('ranks the plan tools for a request that asks to be done in steps', () => {
    const ranked = rankToolNames(
      {
        write_plan: tool('Create or replace the visible task plan.'),
        update_plan_step: tool('Mark a step of the current plan in progress or completed.'),
        update_change_task: tool('Mark a task of an existing persisted change done or not done.'),
        write_file: tool('Write a new file.')
      },
      'Create a simple, responsive website about the solar system. Lets build it in steps.'
    )

    expect(ranked.indexOf('update_plan_step')).toBeLessThan(ranked.indexOf('update_change_task'))
    expect(ranked.indexOf('write_plan')).toBeLessThan(ranked.indexOf('update_change_task'))
  })
})

describe('the deferred-tool gateway', () => {
  /** A surface small enough that only the highest-ranked tool stays native. */
  function routedSurface(): ReturnType<typeof boundToolSurface> {
    return boundToolSurface({
      allFunctions: {
        read_file: tool('Read a file from the workspace and return its contents.'),
        send_email: tool('Send an email message to the given recipients.'),
        list_mailboxes: tool('List the mailboxes available on an email account.'),
        generate_image: tool('Generate an image from a text description.')
      },
      define: fakeDefine,
      routingText: 'read the source file',
      targetFixedTokens: 500,
      measureFixedTokens: fixedCost,
      maxDirectTools: 1
    })
  }

  it('always adds exactly the gateway tools it publishes a count for', () => {
    // `LlamaVisionService` reserves prompt room for these before the surface
    // exists, and used its own hardcoded 3 to do it.
    const surface = routedSurface()
    const gatewayNames = Object.keys(surface.functions).filter(
      (name) => !surface.directToolNames.includes(name)
    )

    expect(gatewayNames).toHaveLength(GATEWAY_TOOL_COUNT)
    expect(gatewayNames).toEqual([
      'find_available_tool',
      'describe_available_tool',
      'call_available_tool'
    ])
  })

  it('accounts for every tool exactly once, native or deferred', () => {
    // A tool in neither list is one the model can never reach.
    const surface = routedSurface()
    const reachable = [...surface.directToolNames, ...surface.deferredToolNames].sort()

    expect(reachable).toEqual(['generate_image', 'list_mailboxes', 'read_file', 'send_email'])
    expect(surface.directToolNames).toEqual(['read_file'])
  })

  it('finds a deferred tool by capability rather than by its exact name', async () => {
    // The whole point of the gateway: the model does not know these names,
    // because their schemas were never put in front of it.
    const surface = routedSurface()
    const find = surface.functions.find_available_tool

    const result = (await find.handler({ query: 'send a message to someone' })) as string

    expect(result).toContain('send_email')
  })

  it('tolerates harmless wrapper punctuation around a known deferred tool name', async () => {
    const surface = routedSurface()
    const call = surface.functions.call_available_tool

    await expect(call.handler({ name: '"send_email>', argumentsJson: '{}' })).resolves.toBe('ok')
  })

  it('says so plainly when nothing matches, rather than listing everything', async () => {
    const surface = routedSurface()
    const find = surface.functions.find_available_tool

    const result = (await find.handler({ query: 'quantum chromodynamics' })) as string

    expect(result).toContain('No deferred tools matched')
  })

  it('refuses to describe a tool that is native rather than deferred', async () => {
    // `read_file` is on the native surface, so the gateway does not own it and
    // must not pretend to — the model already has its real schema.
    const surface = routedSurface()
    const describe = surface.functions.describe_available_tool

    const result = (await describe.handler({ name: 'read_file' })) as string

    expect(result).toContain('No deferred tool named')
  })

  it('refuses to call a tool that is native rather than deferred', async () => {
    const surface = routedSurface()
    const call = surface.functions.call_available_tool

    await expect(call.handler({ name: 'read_file', argumentsJson: '{}' })).rejects.toThrow(
      /No deferred tool named/
    )
  })
})

describe('maxDirectToolsForContext', () => {
  it('never leaves a model with fewer native schemas than it can work with', () => {
    // Both transports had their own byte-identical copy of this; it is the one
    // knob deciding how much of the catalog a model is told about directly.
    expect(maxDirectToolsForContext(1_024)).toBe(8)
    expect(maxDirectToolsForContext(0)).toBe(8)
  })

  it('grows with the context and then stops', () => {
    expect(maxDirectToolsForContext(8_192)).toBe(12)
    expect(maxDirectToolsForContext(1_000_000)).toBe(24)
  })
})
