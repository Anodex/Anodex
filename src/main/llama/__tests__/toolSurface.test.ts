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
  /**
   * The floor must yield to a context that cannot hold it.
   *
   * `minDirectTools` exists so an 8K project run is never admitted
   * `finish_goal`, `list_directory`, `read_file_range` and nothing else - a
   * surface that can read but neither edit nor run is broken, not smaller. It
   * is honoured by skipping the token check while below the floor.
   *
   * At a small enough context that skip stops being a rescue and becomes the
   * failure. Measured on a 13B at 4096: the floor admitted ten schemas costing
   * 2,283 tokens on top of an 1,801-token system prompt, for 4,146 fixed
   * against an input limit of 3,687. Generation was impossible, so every one of
   * twelve turns returned zero characters with stopReason
   * `fixed-context-limit`. The guard against a crippled surface produced a
   * completely dead one.
   *
   * So the floor stays a preference and `hardLimitTokens` is the line it may
   * not cross. Admitting fewer tools than the loop needs is bad; admitting a
   * set that cannot generate at all is worse, and only the second one is
   * silent.
   */
  it('yields the floor rather than exceeding a hard limit', () => {
    const allFunctions = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`tool_${index}`, tool(`Tool ${index}.`)])
    )

    const result = boundToolSurface({
      allFunctions,
      define: fakeDefine,
      // Deliberately generous, as the real budget was: the target alone does
      // not stop the floor.
      targetFixedTokens: 10_000,
      minDirectTools: 10,
      // Room for the gateway plus about two more tools at 100 each.
      hardLimitTokens: 500,
      measureFixedTokens: fixedCost
    })

    expect(fixedCost(result.functions)).toBeLessThanOrEqual(500)
    expect(result.directToolNames.length).toBeLessThan(10)
    // Still a working surface, not an empty one.
    expect(result.directToolNames.length).toBeGreaterThan(0)
  })

  it('still honours the floor when the hard limit allows it', () => {
    const allFunctions = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`tool_${index}`, tool(`Tool ${index}.`)])
    )

    const result = boundToolSurface({
      allFunctions,
      define: fakeDefine,
      // Tight target, which the floor is meant to override.
      targetFixedTokens: 300,
      minDirectTools: 10,
      hardLimitTokens: 100_000,
      measureFixedTokens: fixedCost
    })

    expect(result.directToolNames.length).toBe(10)
  })

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

  /**
   * A dead end found in a real run's log. A schema mismatch told the model to
   * "call describe_available_tool and try again"; the model was already inside
   * `call_available_tool`, so it wrapped that call too — and got "No deferred
   * tool named describe_available_tool. Use find_available_tool first", which
   * sends it somewhere that also cannot help. Anodex's own advice walked it
   * into a loop.
   */
  describe('gateway tools reached through the gateway', () => {
    function routed(): ReturnType<typeof boundToolSurface> {
      return boundToolSurface({
        allFunctions: {
          send_email: tool('Send an email.'),
          web_search: tool('Search the web.'),
          remember_fact: tool('Remember a fact.'),
          draft_email: tool('Draft an email.')
        },
        define: fakeDefine,
        targetFixedTokens: 300,
        measureFixedTokens: fixedCost
      })
    }

    it('says a gateway tool is direct instead of calling it missing', async () => {
      await expect(
        routed().functions.call_available_tool.handler({
          name: 'describe_available_tool',
          argumentsJson: '{"name":"send_email"}'
        })
      ).rejects.toThrow(/gateway tools, not a deferred one/)
    })

    it('tells the model to call it directly, not through the gateway', async () => {
      await expect(
        routed().functions.call_available_tool.handler({
          name: 'find_available_tool',
          argumentsJson: '{"query":"email"}'
        })
      ).rejects.toThrow(/Call it directly/)
    })

    it('still reports a genuinely unknown tool as unknown', async () => {
      await expect(
        routed().functions.call_available_tool.handler({
          name: 'no_such_tool',
          argumentsJson: '{}'
        })
      ).rejects.toThrow(/No deferred tool named "no_such_tool"/)
    })

    it('does not send a schema mismatch back through the gateway', async () => {
      // The message that started the loop. It must not read as "pass
      // describe_available_tool to call_available_tool", which is exactly what
      // the model did.
      const strict = {
        description: 'Write a plan.',
        params: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        handler: vi.fn(() => Promise.resolve('ok'))
      } as ToolFunction
      const result = boundToolSurface({
        allFunctions: {
          write_plan: strict,
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
          name: 'write_plan',
          argumentsJson: '{}'
        })
      ).rejects.toThrow(/describe_available_tool directly/)
    })
  })

  /**
   * `read_multiple_files` sat at the end of the priority list, past
   * `maxDirectToolsForContext`'s ceiling of 16, so it was deferred at *every*
   * context size on every machine — and a model needing several files called
   * `read_file` once per file instead. A measured turn read the same five files
   * five times over.
   */
  it('offers batched reading directly once the window has room for it', () => {
    const ranked = rankToolNames({
      read_multiple_files: tool('Read several files.'),
      inspect_visual: tool('Screenshot a page.'),
      preview_html: tool('Preview a page.'),
      show_image: tool('Show an image.'),
      read_file: tool('Read a file.')
    })

    // Above the visual tools, below the single-file read it complements.
    expect(ranked.indexOf('read_multiple_files')).toBeGreaterThan(ranked.indexOf('read_file'))
    expect(ranked.indexOf('read_multiple_files')).toBeLessThan(ranked.indexOf('inspect_visual'))
    expect(ranked.indexOf('read_multiple_files')).toBeLessThan(maxDirectToolsForContext(32_768))
  })

  it('still defers batched reading on a window too small to spend on it', () => {
    expect(maxDirectToolsForContext(8_192)).toBeLessThan(11)
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
  /**
   * `DIRECT_TOOL_PRIORITY`'s first ten entries are documented as a complete
   * builder loop -- orient, read, locate, edit, run. The old floor of 6 cut
   * into it: a 4,096-token context got seven tools and so had no `write_file`
   * and no `run_command`, and 8,192 still had no `run_command`. Both stayed
   * reachable through the gateway, at three round trips per write, on exactly
   * the setup least able to afford them.
   */
  it('never drops below the complete builder loop, however small the context', () => {
    expect(maxDirectToolsForContext(0)).toBe(10)
    expect(maxDirectToolsForContext(1_024)).toBe(10)
    expect(maxDirectToolsForContext(4_096)).toBe(10)
    expect(maxDirectToolsForContext(8_192)).toBe(10)
  })

  /**
   * Held at 16, a 262,144-token context saw exactly what a 40,960 one did while
   * its entire deferred catalogue would have cost under 3% of the window.
   */
  it('gives a larger context more of the catalogue', () => {
    expect(maxDirectToolsForContext(32_768)).toBe(14)
    expect(maxDirectToolsForContext(65_536)).toBe(22)
    // The ceiling is a coarse backstop; `boundToolSurface` measures each
    // candidate against the real token budget and stops when it runs out.
    expect(maxDirectToolsForContext(1_000_000)).toBe(32)
  })
})

/**
 * A search cannot surface a capability the model never thought to look for.
 * `web_search` was configured and working, yet deferred on every machine at
 * every context size, so a model reasoned from memory about a Win32 API rather
 * than looking it up -- it had no way to learn the tool existed.
 */
describe('the deferred gateway names the whole catalogue', () => {
  it('lists every tool by name in find_available_tool, deferred or not', () => {
    const result = boundToolSurface({
      // Six tools against a 500 budget forces routing, as elsewhere in this file.
      allFunctions: {
        read_file: tool('Read a file.'),
        list_directory: tool('List directories.'),
        web_search: tool('Search the public web.'),
        send_email: tool('Send an email.'),
        draft_email: tool('Draft an email.'),
        remember_fact: tool('Save a personal memory.')
      },
      define: fakeDefine,
      targetFixedTokens: 500,
      measureFixedTokens: fixedCost
    })

    expect(result.routed).toBe(true)
    const find = result.functions.find_available_tool as unknown as { description: string }
    for (const name of ['read_file', 'list_directory', 'web_search', 'send_email']) {
      expect(find.description).toContain(name)
    }
  })

  it('says nothing extra when there is no catalogue to name', () => {
    const result = boundToolSurface({
      allFunctions: {},
      define: fakeDefine,
      targetFixedTokens: 500,
      measureFixedTokens: fixedCost
    })

    expect(result.routed).toBe(false)
  })
})
