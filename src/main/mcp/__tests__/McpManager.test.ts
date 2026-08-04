import { describe, expect, it, vi } from 'vitest'
import type { McpLocalServerConfig, McpRemoteServerConfig } from '@shared/mcp.types'
import { mergeSecretEnvironment, normalizeToolResult, toDescriptor } from '../McpManager'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/anodex-test', getVersion: () => '0.0.0-test' }
}))

const server: McpLocalServerConfig = {
  id: 'srv_1',
  name: 'Everything',
  enabled: true,
  type: 'local',
  command: ['npx', '-y', '@modelcontextprotocol/server-everything']
}

describe('toDescriptor', () => {
  it('qualifies the tool name with the server id to avoid cross-server collisions', () => {
    const descriptor = toDescriptor(server, {
      name: 'add',
      description: 'Add two numbers',
      inputSchema: { type: 'object', properties: {} }
    })
    expect(descriptor.qualifiedName).toBe('srv_1__add')
    expect(descriptor.serverName).toBe('Everything')
    expect(descriptor.toolName).toBe('add')
    expect(descriptor.readOnly).toBe(false)
    expect(descriptor.risk).toBe('sensitive')
  })

  it('trusts read-only annotations only for the managed GitHub preset', () => {
    const github: McpRemoteServerConfig = {
      id: 'github',
      name: 'GitHub',
      enabled: true,
      type: 'remote',
      preset: 'github',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { 'X-MCP-Readonly': 'false' }
    }
    const descriptor = toDescriptor(github, {
      name: 'get_me',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true }
    })
    expect(descriptor.readOnly).toBe(true)
    expect(descriptor.risk).toBe('safe')
    expect(descriptor.forceConfirm).toBe(false)
  })

  it('keeps destructive GitHub tools in the destructive risk tier', () => {
    const github: McpRemoteServerConfig = {
      id: 'github',
      name: 'GitHub',
      enabled: true,
      type: 'remote',
      preset: 'github',
      url: 'https://api.githubcopilot.com/mcp/'
    }
    const descriptor = toDescriptor(github, {
      name: 'delete_file',
      inputSchema: { type: 'object' },
      annotations: { destructiveHint: true }
    })
    expect(descriptor.readOnly).toBe(false)
    expect(descriptor.risk).toBe('destructive')
    expect(descriptor.forceConfirm).toBe(true)
  })

  it('falls back to an empty-object schema when the server omits one', () => {
    const descriptor = toDescriptor(server, { name: 'ping', inputSchema: undefined })
    expect(descriptor.inputSchema).toEqual({ type: 'object', properties: {} })
    expect(descriptor.description).toBe('')
  })
})

describe('normalizeToolResult', () => {
  it('joins text content blocks with newlines', () => {
    const result = normalizeToolResult({
      content: [
        { type: 'text', text: 'first line' },
        { type: 'text', text: 'second line' }
      ]
    })
    expect(result).toBe('first line\nsecond line')
  })

  it('describes a resource block by its text, falling back to its uri', () => {
    const withText = normalizeToolResult({
      content: [{ type: 'resource', resource: { uri: 'file:///a.txt', text: 'contents' } }]
    })
    expect(withText).toBe('contents')

    const withoutText = normalizeToolResult({
      content: [{ type: 'resource', resource: { uri: 'file:///a.txt' } }]
    })
    expect(withoutText).toBe('[resource: file:///a.txt]')
  })

  it('labels non-text/resource blocks generically', () => {
    const result = normalizeToolResult({
      content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }]
    })
    expect(result).toBe('[image content]')
  })

  it('prefixes an error result, falling back to a generic message when there is no text', () => {
    expect(
      normalizeToolResult({ isError: true, content: [{ type: 'text', text: 'bad input' }] })
    ).toBe('Error: bad input')
    expect(normalizeToolResult({ isError: true, content: [] })).toBe('Error: Tool call failed')
  })

  it('falls back to "(no output)" for a successful call with no content', () => {
    expect(normalizeToolResult({ content: [] })).toBe('(no output)')
  })

  it('prefers structured toolResult over content blocks when present', () => {
    expect(
      normalizeToolResult({ toolResult: { sum: 4 }, content: [{ type: 'text', text: 'ignored' }] })
    ).toBe('{"sum":4}')
  })

  it('prefers standard structuredContent when present', () => {
    expect(normalizeToolResult({ structuredContent: { login: 'octocat' } })).toBe(
      '{"login":"octocat"}'
    )
  })
})

describe('mergeSecretEnvironment', () => {
  it('preserves blank existing values, replaces supplied values, and removes omitted keys', () => {
    expect(
      mergeSecretEnvironment(
        { KEEP: 'secret', REPLACE: 'old', REMOVE: 'gone' },
        { KEEP: '', REPLACE: 'new' }
      )
    ).toEqual({ KEEP: 'secret', REPLACE: 'new' })
  })
})

describe('toDescriptor — how much a server is trusted decides how much it is gated', () => {
  const github: McpRemoteServerConfig = {
    id: 'github',
    name: 'GitHub',
    enabled: true,
    type: 'remote',
    preset: 'github',
    url: 'https://api.githubcopilot.com/mcp/'
  }

  it('gates an unvetted third-party tool at least as tightly as the trusted preset', () => {
    // `forceConfirm` only bites in `untethered`, the one mode where `sensitive`
    // auto-runs. A generic server's tool used to skip the prompt there while
    // GitHub's equivalent still raised one — the less the server is known, the
    // less it was asked about.
    const generic = toDescriptor(server, { name: 'anything', inputSchema: { type: 'object' } })
    const trusted = toDescriptor(github, { name: 'create_pull_request', inputSchema: {} })

    expect(trusted.forceConfirm).toBe(true)
    expect(generic.forceConfirm).toBe(true)
  })

  // This and the next pass against the pre-fix file. They are what stops the
  // change above from drifting into "prompt for everything" or "trust the
  // annotations after all".
  it('still refuses to let a generic server downgrade itself with annotations', () => {
    // The point of the preset check: annotations are hints, and a server that
    // claims to be read-only must not be believed into a lower risk tier.
    const descriptor = toDescriptor(server, {
      name: 'definitely_safe',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    })

    expect(descriptor.readOnly).toBe(false)
    expect(descriptor.risk).toBe('sensitive')
  })

  it('leaves a verified read-only preset tool unprompted', () => {
    // The fix must not turn every MCP call into a prompt — a tool that is
    // genuinely a read never reaches the guarded path at all.
    const descriptor = toDescriptor(github, {
      name: 'get_me',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    })

    expect(descriptor.readOnly).toBe(true)
    expect(descriptor.forceConfirm).toBe(false)
  })
})
