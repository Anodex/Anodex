import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpLocalServerConfig } from '@shared/mcp.types'

/**
 * The first coverage of `McpManager` the class. Its 12 existing tests all
 * exercise pure helpers — `toDescriptor`, `normalizeToolResult`,
 * `mergeSecretEnvironment` — and none of them reach connection handling or call
 * dispatch, which is where a third-party server actually gets to misbehave.
 *
 * The MCP SDK is mocked at the `Client` boundary, so what is asserted is what
 * the manager asks the SDK to do.
 */

interface ListChangedHandlers {
  tools?: { onChanged?: (error: unknown, listed: unknown[] | undefined) => void }
}

const mocks = vi.hoisted(() => ({
  /** Every `callTool` invocation, with the options the manager passed. */
  calls: [] as Array<{ params: unknown; options: unknown }>,
  /** Resolved by `callTool`; set per test. */
  callResult: {},
  callError: null as Error | null,
  /** Every constructed client, newest last. */
  clients: [] as Array<{ id: number; listChanged?: ListChangedHandlers }>,
  tools: [{ name: 'do_thing', inputSchema: { type: 'object' } }],
  closed: [] as number[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/anodex-test', getVersion: () => '0.0.0-test' }
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  let nextId = 0
  class Client {
    id = ++nextId
    onclose?: () => void
    onerror?: (error: unknown) => void
    constructor(_info: unknown, options?: { listChanged?: ListChangedHandlers }) {
      mocks.clients.push({ id: this.id, listChanged: options?.listChanged })
    }
    connect(): Promise<void> {
      return Promise.resolve()
    }
    listTools(): Promise<{ tools: unknown[] }> {
      return Promise.resolve({ tools: mocks.tools })
    }
    callTool(params: unknown, _schema: unknown, options: unknown): Promise<unknown> {
      mocks.calls.push({ params, options })
      if (mocks.callError) return Promise.reject(mocks.callError)
      return Promise.resolve(mocks.callResult)
    }
    close(): Promise<void> {
      mocks.closed.push(this.id)
      return Promise.resolve()
    }
  }
  return { Client }
})

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {}
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {}
}))
vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  UnauthorizedError: class extends Error {}
}))
vi.mock('../McpServerStore', () => ({ mcpServerStore: { list: () => [], get: () => undefined } }))
vi.mock('../McpAuthStore', () => ({ mcpAuthStore: { get: () => undefined } }))
vi.mock('../oauth', () => ({ McpOAuthProvider: class {} }))

const { mcpManager } = await import('../McpManager')
const { ErrorCode, McpError } = await import('@modelcontextprotocol/sdk/types.js')

const server: McpLocalServerConfig = {
  id: 'srv_1',
  name: 'Everything',
  enabled: true,
  type: 'local',
  command: ['npx', '-y', 'server-everything']
}

beforeEach(() => {
  mocks.calls.length = 0
  mocks.clients.length = 0
  mocks.closed.length = 0
  mocks.callError = null
  mocks.callResult = { content: [{ type: 'text', text: 'ok' }] }
  mocks.tools = [{ name: 'do_thing', inputSchema: { type: 'object' } }]
})

describe('McpManager — a tool call that runs too long', () => {
  it('gives the SDK the deadline instead of racing it', async () => {
    // Racing a promise only stops the manager waiting. The request stays in the
    // client's response map for the life of the connection and the server keeps
    // working, with nothing left to receive the result. Handing the SDK the
    // timeout makes it send `notifications/cancelled` and drop the handler.
    await mcpManager.connectServer(server)
    await mcpManager.callToolResult('srv_1', 'do_thing', {})

    expect(mocks.calls).toHaveLength(1)
    const { timeout } = mocks.calls[0].options as { timeout?: number }
    expect(timeout).toBeGreaterThan(0)
  })

  it('names the tool when reporting a timeout', async () => {
    // The model reads this as the tool result; the SDK's own text is a bare
    // "Request timed out" that says nothing about what timed out.
    mocks.callError = new McpError(ErrorCode.RequestTimeout, 'Request timed out')
    await mcpManager.connectServer(server)

    await expect(mcpManager.callToolResult('srv_1', 'do_thing', {})).rejects.toThrow(
      /MCP tool "do_thing" timed out/
    )
  })

  // This and the next pass against the pre-fix file. They guard the new catch
  // from swallowing or re-labelling anything it was not meant to touch.
  it('passes a non-timeout failure through untouched', async () => {
    mocks.callError = new Error('the server said no')
    await mcpManager.connectServer(server)

    await expect(mcpManager.callToolResult('srv_1', 'do_thing', {})).rejects.toThrow(
      'the server said no'
    )
  })

  it('refuses a call to a server that is not connected', async () => {
    await expect(mcpManager.callToolResult('never_connected', 'do_thing', {})).rejects.toThrow(
      /not currently connected/
    )
  })
})

describe('McpManager — a tool list arriving from a replaced connection', () => {
  it('ignores a notification from a client that has since been replaced', async () => {
    await mcpManager.connectServer(server)
    const stale = mocks.clients[0]

    mocks.tools = [
      { name: 'do_thing', inputSchema: { type: 'object' } },
      { name: 'new_thing', inputSchema: { type: 'object' } }
    ]
    await mcpManager.connectServer(server)
    expect(mcpManager.listTools()).toHaveLength(2)

    // The old client's in-flight notification lands after the reconnect.
    stale.listChanged?.tools?.onChanged?.(null, [{ name: 'gone', inputSchema: {} }])

    const names = mcpManager.listTools().map((tool) => tool.toolName)
    expect(names).toEqual(['do_thing', 'new_thing'])
  })

  // Passes pre-fix too: the other half of the identity check, so the added
  // guard cannot be "ignore every notification".
  it('still applies a notification from the live connection', async () => {
    await mcpManager.connectServer(server)
    const live = mocks.clients[0]

    live.listChanged?.tools?.onChanged?.(null, [{ name: 'replaced', inputSchema: {} }])

    expect(mcpManager.listTools().map((tool) => tool.toolName)).toEqual(['replaced'])
  })
})
