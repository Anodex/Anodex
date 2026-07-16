import type {
  GithubAccount,
  GithubConnectRequest,
  GithubConnectionState,
  GithubToolset
} from '@shared/github.types'
import { GITHUB_MCP_URL, GITHUB_TOOLSETS } from '@shared/github.types'
import type { McpNewRemoteServerConfig, McpServerConfig } from '@shared/mcp.types'
import { createLogger } from '../utils/logger'
import { projectStore } from '../projects/ProjectStore'
import { mcpAuthStore } from '../mcp/McpAuthStore'
import { mcpManager, type McpCallResult } from '../mcp/McpManager'
import { mcpServerStore } from '../mcp/McpServerStore'
import { detectGithubRepository } from './repository'

const log = createLogger('github')
const DEFAULT_TOOLSETS: GithubToolset[] = ['repos', 'issues', 'pull_requests']

class GitHubService {
  private accountCache = new Map<string, GithubAccount>()

  async getState(projectId?: string | null): Promise<GithubConnectionState> {
    const server = findGithubServer()
    const status = server ? mcpManager.getStatus(server.id) : undefined
    const auth = server ? mcpAuthStore.get(server.id) : null
    const project = projectId
      ? projectStore.getState().projects.find((candidate) => candidate.id === projectId)
      : undefined
    const detectedRepository = project
      ? await detectGithubRepository(project.folderPath)
      : undefined
    const account =
      server && status?.status === 'connected' ? await this.getAccount(server) : undefined

    return {
      configured: Boolean(server),
      connected: status?.status === 'connected',
      hasCredential: Boolean(auth?.staticToken || auth?.environment?.GITHUB_PERSONAL_ACCESS_TOKEN),
      serverId: server?.id,
      status: status?.status ?? 'disconnected',
      error: status?.error,
      toolCount: status?.toolCount ?? 0,
      readOnly: server ? githubReadOnly(server) : true,
      toolsets: server ? githubToolsets(server) : DEFAULT_TOOLSETS,
      account,
      activeProjectId: project?.id,
      activeProjectName: project?.name,
      linkedRepository: project?.githubRepository,
      detectedRepository: detectedRepository ?? undefined
    }
  }

  async connect(
    request: GithubConnectRequest,
    projectId?: string | null
  ): Promise<GithubConnectionState> {
    const existing = findGithubServer()
    const existingAuth = existing ? mcpAuthStore.get(existing.id) : null
    const token =
      request.token?.trim() ||
      existingAuth?.staticToken ||
      existingAuth?.environment?.GITHUB_PERSONAL_ACCESS_TOKEN
    if (!token) throw new Error('Paste a fine-grained GitHub personal access token to connect.')

    const config = buildGithubServerConfig(request)
    this.accountCache.clear()
    await mcpManager.replaceServer(config, { staticToken: token }, existing?.id)
    return this.getState(projectId)
  }

  async disconnect(projectId?: string | null): Promise<GithubConnectionState> {
    const server = findGithubServer()
    if (server) await mcpManager.removeServer(server.id)
    this.accountCache.clear()
    return this.getState(projectId)
  }

  detectRepository(projectId: string): Promise<string | null> {
    const project = projectStore.getState().projects.find((candidate) => candidate.id === projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    return detectGithubRepository(project.folderPath)
  }

  private async getAccount(server: McpServerConfig): Promise<GithubAccount | undefined> {
    const cached = this.accountCache.get(server.id)
    if (cached) return cached
    const tool = mcpManager
      .listTools()
      .find((candidate) => candidate.serverId === server.id && candidate.toolName === 'get_me')
    if (!tool) return undefined
    try {
      const result = await mcpManager.callToolResult(server.id, tool.toolName, {})
      if (result.isError) return undefined
      const account = parseGithubAccount(result)
      if (account) this.accountCache.set(server.id, account)
      return account
    } catch (error) {
      log.warn('Could not load the connected GitHub account:', error)
      return undefined
    }
  }
}

export function buildGithubServerConfig(
  request: Pick<GithubConnectRequest, 'readOnly' | 'toolsets'>
): McpNewRemoteServerConfig {
  const selected = GITHUB_TOOLSETS.filter((toolset) => request.toolsets.includes(toolset))
  const toolsets = selected.length ? selected : DEFAULT_TOOLSETS
  return {
    name: 'GitHub',
    enabled: true,
    type: 'remote',
    preset: 'github',
    url: GITHUB_MCP_URL,
    headers: {
      'X-MCP-Toolsets': ['context', ...toolsets].join(','),
      'X-MCP-Readonly': request.readOnly ? 'true' : 'false'
    }
  }
}

export function parseGithubAccount(result: McpCallResult): GithubAccount | undefined {
  const structured = result.structuredContent ?? result.toolResult
  const candidate = structured ?? parseTextContent(result.content)
  const record = findLoginRecord(candidate)
  if (!record || typeof record.login !== 'string') return undefined
  const details =
    record.details && typeof record.details === 'object'
      ? (record.details as Record<string, unknown>)
      : undefined
  return {
    login: record.login,
    name: stringValue(record.name ?? details?.name),
    avatarUrl: stringValue(record.avatar_url ?? record.avatarUrl),
    profileUrl: stringValue(record.html_url ?? record.profile_url ?? record.profileUrl)
  }
}

function findGithubServer(): McpServerConfig | undefined {
  return mcpServerStore.list().find((server) => {
    if (server.preset === 'github') return true
    if (server.type === 'remote') return /api\.githubcopilot\.com\/mcp/i.test(server.url)
    return server.command.join(' ').includes('github-mcp-server')
  })
}

function githubReadOnly(server: McpServerConfig): boolean {
  if (server.type !== 'remote') return false
  const value = headerValue(server, 'x-mcp-readonly')
  return value ? !['false', 'f', 'no', 'n', '0', 'off'].includes(value.toLowerCase()) : false
}

function githubToolsets(server: McpServerConfig): GithubToolset[] {
  if (server.type !== 'remote') return DEFAULT_TOOLSETS
  const configured = (headerValue(server, 'x-mcp-toolsets') ?? '')
    .split(',')
    .map((value) => value.trim())
  const selected = GITHUB_TOOLSETS.filter((toolset) => configured.includes(toolset))
  return selected.length ? selected : DEFAULT_TOOLSETS
}

function headerValue(server: McpNewRemoteServerConfig, name: string): string | undefined {
  return Object.entries(server.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]
}

function parseTextContent(content: unknown[] | undefined): unknown {
  const text = (content ?? [])
    .filter((block): block is { type: string; text: string } =>
      Boolean(
        block &&
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
      )
    )
    .map((block) => block.text)
    .join('\n')
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function findLoginRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.login === 'string') return record
  for (const nested of Object.values(record)) {
    const found = findLoginRecord(nested)
    if (found) return found
  }
  return undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

export const githubService = new GitHubService()
