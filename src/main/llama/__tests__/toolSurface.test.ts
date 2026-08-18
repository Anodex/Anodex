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

  it('prioritizes the autonomous completion signal without interpreting prompt text', () => {
    const ranked = rankToolNames({
      read_file: tool('Read a file.'),
      finish_goal: tool('Finish the autonomous goal.')
    })
    expect(ranked[0]).toBe('finish_goal')
  })

  it('uses the same deterministic builder order for every wording', () => {
    const functions = {
      send_email: tool('Send an email.'),
      run_command: tool('Run a command.'),
      write_file: tool('Write a file.'),
      read_file: tool('Read a file.')
    }

    // The exact order is `DIRECT_TOOL_PRIORITY`'s, and what this asserts is
    // that it comes from that list rather than from anything in the task's
    // wording. `write_file`/`run_command` outrank `read_file` because the first
    // ten entries are tuned to be a complete builder loop on a small window;
    // `send_email` is unranked and sorts last.
    expect(rankToolNames(functions)).toEqual([
      'write_file',
      'run_command',
      'read_file',
      'send_email'
    ])
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

  it('does not map generic project verbs onto unrelated email tools', async () => {
    const surface = routedSurface()
    const find = surface.functions.find_available_tool

    const readResult = (await find.handler({ query: 'read the project file' })) as string
    const searchResult = (await find.handler({ query: 'search for planet images' })) as string

    expect(readResult).not.toContain('send_email')
    expect(readResult).not.toContain('list_mailboxes')
    expect(searchResult).not.toContain('send_email')
    expect(searchResult).not.toContain('list_mailboxes')
  })

  it('still discovers an email tool when the requested domain is explicit', async () => {
    const surface = routedSurface()
    const result = (await surface.functions.find_available_tool.handler({
      query: 'list email mailboxes'
    })) as string

    expect(result).toContain('list_mailboxes')
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
  it('keeps a small core even for a small local context', () => {
    expect(maxDirectToolsForContext(1_024)).toBe(6)
    expect(maxDirectToolsForContext(0)).toBe(6)
  })

  it('grows slowly with context and caps well below the old 24-schema surface', () => {
    expect(maxDirectToolsForContext(8_192)).toBe(8)
    expect(maxDirectToolsForContext(16_384)).toBe(10)
    expect(maxDirectToolsForContext(1_000_000)).toBe(16)
  })
})
