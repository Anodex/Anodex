import type { McpServerConfig } from '@shared/mcp.types'

export interface McpServerDraft {
  name: string
  type: 'local' | 'remote'
  command: string
  environmentText: string
  url: string
  token: string
}

export function draftFromConfig(config?: McpServerConfig): McpServerDraft {
  if (!config) {
    return { name: '', type: 'local', command: '', environmentText: '', url: '', token: '' }
  }
  if (config.type === 'local') {
    return {
      name: config.name,
      type: 'local',
      command: stringifyCommandLine(config.command),
      environmentText: (config.environmentKeys ?? []).map((key) => `${key}=`).join('\n'),
      url: '',
      token: ''
    }
  }
  return {
    name: config.name,
    type: 'remote',
    command: '',
    environmentText: '',
    url: config.url,
    token: ''
  }
}

/** Splits a display command while preserving quoted paths/arguments. */
export function parseCommandLine(command: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote) {
      if (char === '\\' && command[index + 1] === quote) {
        current += quote
        index += 1
      } else if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }
  if (current) args.push(current)
  return args
}

export function stringifyCommandLine(args: string[]): string {
  return args.map((arg) => (/\s|["']/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(' ')
}

/** Parses `KEY=value` lines into an env-var map; `undefined` when there are none. */
export function parseEnvironment(text: string): Record<string, string> | undefined {
  const entries = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separatorIndex = line.indexOf('=')
      if (separatorIndex === -1) return null
      return [line.slice(0, separatorIndex).trim(), line.slice(separatorIndex + 1).trim()] as const
    })
    .filter((entry): entry is readonly [string, string] => entry !== null)
  return entries.length ? Object.fromEntries(entries) : undefined
}
