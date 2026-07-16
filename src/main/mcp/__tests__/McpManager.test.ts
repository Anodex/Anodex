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
