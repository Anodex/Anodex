import { describe, expect, it } from 'vitest'
import type { McpLocalServerConfig, McpRemoteServerConfig } from '@shared/mcp.types'
import {
  draftFromConfig,
  parseCommandLine,
  parseEnvironment,
  stringifyCommandLine
} from '../mcpServerDraft'

describe('draftFromConfig', () => {
  it('starts blank, local, with no config', () => {
    expect(draftFromConfig(undefined)).toEqual({
      name: '',
      type: 'local',
      command: '',
      environmentText: '',
      url: '',
      token: ''
    })
  })

  it('joins a local server command back into a single editable string', () => {
    const config: McpLocalServerConfig = {
      id: 's1',
      name: 'Everything',
      enabled: true,
      type: 'local',
      command: ['npx', '-y', '@modelcontextprotocol/server-everything'],
      environmentKeys: ['FOO', 'BAZ']
    }
    const draft = draftFromConfig(config)
    expect(draft.command).toBe('npx -y @modelcontextprotocol/server-everything')
    expect(draft.environmentText).toBe('FOO=\nBAZ=')
    expect(draft.type).toBe('local')
  })

  it('carries a remote server URL and leaves the token blank (never round-tripped from config)', () => {
    const config: McpRemoteServerConfig = {
      id: 's2',
      name: 'Sentry',
      enabled: true,
      type: 'remote',
      url: 'https://mcp.sentry.dev/mcp'
    }
    const draft = draftFromConfig(config)
    expect(draft.type).toBe('remote')
    expect(draft.url).toBe('https://mcp.sentry.dev/mcp')
    expect(draft.token).toBe('')
  })
})

describe('command line editing', () => {
  it('preserves quoted executable paths and arguments', () => {
    expect(parseCommandLine('"C:\\Program Files\\server.exe" --name "My server"')).toEqual([
      'C:\\Program Files\\server.exe',
      '--name',
      'My server'
    ])
  })

  it('round trips command arguments that contain spaces', () => {
    const args = ['C:\\Program Files\\server.exe', '--name', 'My server']
    expect(parseCommandLine(stringifyCommandLine(args))).toEqual(args)
  })
})

describe('parseEnvironment', () => {
  it('parses KEY=value lines into a map', () => {
    expect(parseEnvironment('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('trims whitespace around keys and values', () => {
    expect(parseEnvironment('  FOO = bar  \n')).toEqual({ FOO: 'bar' })
  })

  it('skips blank lines', () => {
    expect(parseEnvironment('FOO=bar\n\n\nBAZ=qux\n')).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('skips lines with no "=" instead of misparsing them', () => {
    expect(parseEnvironment('not-a-line\nFOO=bar')).toEqual({ FOO: 'bar' })
  })

  it('keeps everything after the first "=" for values containing their own "="', () => {
    expect(parseEnvironment('TOKEN=abc=def=ghi')).toEqual({ TOKEN: 'abc=def=ghi' })
  })

  it('returns undefined for empty or whitespace-only input', () => {
    expect(parseEnvironment('')).toBeUndefined()
    expect(parseEnvironment('   \n  \n')).toBeUndefined()
  })
})
