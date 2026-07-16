import type { McpConnectionStatus } from './mcp.types'

export const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/'

export const GITHUB_TOOLSETS = ['repos', 'issues', 'pull_requests', 'actions'] as const
export type GithubToolset = (typeof GITHUB_TOOLSETS)[number]

export interface GithubConnectRequest {
  /** Optional when reconnecting with an already-saved credential. */
  token?: string
  readOnly: boolean
  toolsets: GithubToolset[]
}

export interface GithubAccount {
  login: string
  name?: string
  avatarUrl?: string
  profileUrl?: string
}

export interface GithubConnectionState {
  configured: boolean
  connected: boolean
  hasCredential: boolean
  serverId?: string
  status: McpConnectionStatus
  error?: string
  toolCount: number
  readOnly: boolean
  toolsets: GithubToolset[]
  account?: GithubAccount
  activeProjectId?: string
  activeProjectName?: string
  linkedRepository?: string
  detectedRepository?: string
}
