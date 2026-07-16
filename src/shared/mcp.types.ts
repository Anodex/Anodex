import type { ToolRisk } from './tools.types'

/** Types for the MCP client: server configs, discovered tools, and connection status. */

export type McpServerPreset = 'github'

interface McpServerConfigBase {
  id: string
  name: string
  enabled: boolean
  /** Identifies a trusted, Anodex-managed preset without restricting generic MCP servers. */
  preset?: McpServerPreset
}

export interface McpLocalServerConfig extends McpServerConfigBase {
  type: 'local'
  /** Executable + args, e.g. `['npx', '-y', '@modelcontextprotocol/server-everything']`. */
  command: string[]
  cwd?: string
  /** Names only. Values are encrypted separately in `McpAuthStore` and never cross IPC. */
  environmentKeys?: string[]
}

export interface McpRemoteServerConfig extends McpServerConfigBase {
  type: 'remote'
  url: string
  /** Non-secret server configuration headers. Bearer credentials are stored separately. */
  headers?: Record<string, string>
}

export type McpServerConfig = McpLocalServerConfig | McpRemoteServerConfig

export type McpNewLocalServerConfig = Omit<McpLocalServerConfig, 'id' | 'environmentKeys'> & {
  /** Environment values are accepted on write, encrypted, and replaced with `environmentKeys`. */
  environment?: Record<string, string>
}

export type McpNewRemoteServerConfig = Omit<McpRemoteServerConfig, 'id'>

export type McpNewServerConfig = McpNewLocalServerConfig | McpNewRemoteServerConfig

export type McpServerPatch =
  Partial<Omit<McpNewLocalServerConfig, 'type'>> | Partial<Omit<McpNewRemoteServerConfig, 'type'>>

/** Secrets supplied alongside a config mutation so they are committed before connecting. */
export interface McpServerCredentials {
  staticToken?: string
}

export interface McpToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/** A tool discovered from a connected MCP server. */
export interface McpToolDescriptor {
  serverId: string
  serverName: string
  /** The tool's own name, as reported by the server. */
  toolName: string
  /** `${serverId}__${toolName}` — collision-safe name actually registered as a callable tool. */
  qualifiedName: string
  description: string
  /** JSON Schema for the tool's parameters, passed straight through to model function calling. */
  inputSchema: Record<string, unknown>
  annotations?: McpToolAnnotations
  /** Trusted execution classification. Generic-server annotations never reduce confirmations. */
  risk: ToolRisk
  /** True only when Anodex can trust that this tool cannot mutate external state. */
  readOnly: boolean
  /** Managed external writes can require confirmation regardless of global permission mode. */
  forceConfirm: boolean
}

export type McpConnectionStatus =
  'disconnected' | 'connecting' | 'connected' | 'auth-required' | 'error'

export interface McpServerState {
  id: string
  status: McpConnectionStatus
  error?: string
  toolCount?: number
}
