import { EventEmitter } from 'node:events'
import { app } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  McpNewServerConfig,
  McpServerConfig,
  McpServerCredentials,
  McpServerPatch,
  McpServerState,
  McpToolAnnotations,
  McpToolDescriptor
} from '@shared/mcp.types'
import { createLogger } from '../utils/logger'
import { mcpServerStore } from './McpServerStore'
import { mcpAuthStore } from './McpAuthStore'
import { McpOAuthProvider } from './oauth'

const log = createLogger('mcp')
const MCP_CONNECT_TIMEOUT_MS = 20_000
const MCP_TOOL_TIMEOUT_MS = 60_000

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema: unknown
  annotations?: McpToolAnnotations
}

export interface McpCallResult {
  content?: unknown[]
  isError?: boolean
  structuredContent?: unknown
  /** Compatibility with servers that used the pre-standard structured-result field. */
  toolResult?: unknown
}

interface ConnectedServer {
  config: McpServerConfig
  client: Client
  tools: McpToolDescriptor[]
}

/** Owns MCP connections, encrypted credentials, discovered tools, and call dispatch. */
class McpManager extends EventEmitter {
  private connections = new Map<string, ConnectedServer>()
  private statuses = new Map<string, McpServerState>()
  private connectionAttempts = new Map<string, number>()

  /** Migrates legacy plaintext env values, then connects enabled servers without blocking startup. */
  init(): void {
    this.migrateLegacyEnvironmentValues()
    for (const server of mcpServerStore.list()) {
      if (server.enabled) {
        void this.connectServer(server).catch(() => undefined)
      } else {
        this.setStatus({ id: server.id, status: 'disconnected' })
      }
    }
  }

  getStatus(id: string): McpServerState {
    return this.statuses.get(id) ?? { id, status: 'disconnected' }
  }

  getAllStatuses(): McpServerState[] {
    return mcpServerStore.list().map((server) => this.getStatus(server.id))
  }

  /** Discovery happens at connect time, so a generation never waits on a server. */
  listTools(): McpToolDescriptor[] {
    return Array.from(this.connections.values()).flatMap((connection) => connection.tools)
  }

  async connectServer(config: McpServerConfig): Promise<void> {
    const attempt = this.bumpAttempt(config.id)
    await this.closeConnection(config.id)
    this.setStatus({ id: config.id, status: 'connecting' })

    try {
      const { client, tools } = await this.connectClient(config)
      if (this.connectionAttempts.get(config.id) !== attempt) {
        await client.close().catch(() => undefined)
        return
      }

      const connection = { config, client, tools }
      this.connections.set(config.id, connection)
      client.onclose = () => this.handleUnexpectedClose(config.id, client)
      client.onerror = (error) => log.warn(`MCP server "${config.name}" transport error:`, error)
      this.setStatus({ id: config.id, status: 'connected', toolCount: tools.length })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (this.connectionAttempts.get(config.id) === attempt) {
        this.setStatus({
          id: config.id,
          status: error instanceof UnauthorizedError ? 'auth-required' : 'error',
          error: message
        })
      }
      log.warn(`Failed to connect MCP server "${config.name}":`, message)
      throw error
    }
  }

  async disconnectServer(id: string): Promise<void> {
    this.bumpAttempt(id)
    await this.closeConnection(id)
    this.setStatus({ id, status: 'disconnected' })
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(Array.from(this.connections.keys()).map((id) => this.disconnectServer(id)))
  }

  async testConnection(
    config: McpServerConfig
  ): Promise<{ ok: true; toolCount: number } | { ok: false; error: string }> {
    try {
      const { client, tools } = await this.connectClient(config)
      await client.close()
      return { ok: true, toolCount: tools.length }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async callToolResult(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<McpCallResult> {
    const connection = this.connections.get(serverId)
    if (!connection) throw new Error('This MCP server is not currently connected.')
    return withTimeout(
      connection.client.callTool({ name: toolName, arguments: args }) as Promise<McpCallResult>,
      MCP_TOOL_TIMEOUT_MS,
      `MCP tool "${toolName}" timed out.`
    )
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<string> {
    const result = await this.callToolResult(serverId, toolName, args)
    const normalized = normalizeToolResult(result)
    if (result.isError) throw new Error(normalized.replace(/^Error:\s*/, ''))
    return normalized
  }

  async disconnectAuth(id: string): Promise<void> {
    await this.disconnectServer(id)
    mcpAuthStore.clear(id)
  }

  /** Saves credentials before starting the connection, avoiding token/OAuth races. */
  addServer(config: McpNewServerConfig, credentials: McpServerCredentials = {}): McpServerConfig {
    const saved = mcpServerStore.add(config)
    this.saveCredentials(saved, config, credentials)
    if (saved.enabled) void this.connectServer(saved).catch(() => undefined)
    return saved
  }

  async updateServer(
    id: string,
    patch: McpServerPatch,
    credentials: McpServerCredentials = {}
  ): Promise<McpServerConfig> {
    const current = mcpServerStore.get(id)
    if (!current) throw new Error(`MCP server not found: ${id}`)

    const storedPatch = { ...patch } as Partial<McpServerConfig> & {
      environment?: Record<string, string>
      environmentKeys?: string[]
    }
    if (current.type === 'local' && 'environment' in storedPatch) {
      const nextEnvironment = mergeSecretEnvironment(
        mcpAuthStore.get(id)?.environment,
        storedPatch.environment
      )
      delete storedPatch.environment
      storedPatch.environmentKeys = Object.keys(nextEnvironment)
      mcpAuthStore.update(id, {
        environment: Object.keys(nextEnvironment).length ? nextEnvironment : undefined
      })
    }
    if (current.type === 'remote' && credentials.staticToken !== undefined) {
      mcpAuthStore.update(id, { staticToken: credentials.staticToken || undefined })
    }

    const saved = mcpServerStore.update(id, storedPatch)
    if (saved.enabled) {
      void this.connectServer(saved).catch(() => undefined)
    } else {
      await this.disconnectServer(id)
    }
    return saved
  }

  /** Atomically replaces a managed preset, stores its token, and verifies the connection. */
  async replaceServer(
    config: McpNewServerConfig,
    credentials: McpServerCredentials,
    existingId?: string
  ): Promise<McpServerConfig> {
    let saved: McpServerConfig
    if (existingId) {
      await this.disconnectServer(existingId)
      saved = mcpServerStore.replace(existingId, config)
    } else {
      saved = mcpServerStore.add(config)
    }
    this.saveCredentials(saved, config, credentials)
    if (saved.enabled) await this.connectServer(saved)
    return saved
  }

  async removeServer(id: string): Promise<void> {
    await this.disconnectServer(id)
    mcpAuthStore.clear(id)
    mcpServerStore.remove(id)
    this.statuses.delete(id)
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServerConfig> {
    return this.updateServer(id, { enabled })
  }

  async setStaticToken(id: string, token: string): Promise<void> {
    mcpAuthStore.update(id, { staticToken: token || undefined })
    const config = mcpServerStore.get(id)
    if (config?.enabled) await this.connectServer(config)
  }

  private async connectClient(
    config: McpServerConfig
  ): Promise<{ client: Client; tools: McpToolDescriptor[] }> {
    const client = new Client(
      { name: 'anodex', version: app.getVersion() },
      {
        capabilities: {},
        listChanged: {
          tools: {
            onChanged: (error, listed) => {
              if (error || !listed) return
              const connection = this.connections.get(config.id)
              if (!connection) return
              connection.tools = listed.map((tool) => toDescriptor(config, tool))
              this.setStatus({
                id: config.id,
                status: 'connected',
                toolCount: connection.tools.length
              })
            }
          }
        }
      }
    )

    const { transport, oauthProvider } = this.buildTransport(config)
    try {
      try {
        await withTimeout(
          client.connect(transport),
          MCP_CONNECT_TIMEOUT_MS,
          `Connection to "${config.name}" timed out.`
        )
      } catch (error) {
        if (error instanceof UnauthorizedError && oauthProvider) {
          const code = await oauthProvider.waitForPendingCode()
          await withTimeout(
            (transport as StreamableHTTPClientTransport).finishAuth(code),
            MCP_CONNECT_TIMEOUT_MS,
            `Authorization for "${config.name}" timed out.`
          )
          await withTimeout(
            client.connect(transport),
            MCP_CONNECT_TIMEOUT_MS,
            `Connection to "${config.name}" timed out.`
          )
        } else {
          throw error
        }
      }

      const listed = await withTimeout(
        client.listTools(),
        MCP_CONNECT_TIMEOUT_MS,
        `Tool discovery for "${config.name}" timed out.`
      )
      return { client, tools: listed.tools.map((tool) => toDescriptor(config, tool)) }
    } catch (error) {
      await client.close().catch(() => undefined)
      throw error
    }
  }

  private buildTransport(config: McpServerConfig): {
    transport: Transport
    oauthProvider?: McpOAuthProvider
  } {
    if (config.type === 'local') {
      const [command, ...args] = config.command
      if (!command) throw new Error('Local MCP server command cannot be empty.')
      return {
        transport: new StdioClientTransport({
          command,
          args,
          cwd: config.cwd,
          env: mcpAuthStore.get(config.id)?.environment
        })
      }
    }

    const staticToken = mcpAuthStore.get(config.id)?.staticToken
    if (staticToken) {
      return {
        transport: new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: { ...config.headers, Authorization: `Bearer ${staticToken}` } }
        })
      }
    }

    const oauthProvider = new McpOAuthProvider(config.id)
    return {
      transport: new StreamableHTTPClientTransport(new URL(config.url), {
        authProvider: oauthProvider,
        requestInit: config.headers ? { headers: config.headers } : undefined
      }),
      oauthProvider
    }
  }

  private saveCredentials(
    saved: McpServerConfig,
    config: McpNewServerConfig,
    credentials: McpServerCredentials
  ): void {
    if (config.type === 'local') {
      const environment = cleanEnvironment(config.environment)
      if (Object.keys(environment).length) mcpAuthStore.set(saved.id, { environment })
      return
    }
    if (credentials.staticToken) {
      mcpAuthStore.set(saved.id, { staticToken: credentials.staticToken })
    }
  }

  private migrateLegacyEnvironmentValues(): void {
    const servers = [...mcpServerStore.list()]
    for (const server of servers) {
      if (server.type !== 'local') continue
      const legacy = server as typeof server & { environment?: Record<string, string> }
      if (!legacy.environment || Object.keys(legacy.environment).length === 0) continue
      const environment = cleanEnvironment(legacy.environment)
      try {
        if (Object.keys(environment).length) {
          mcpAuthStore.update(server.id, { environment })
        }
        mcpServerStore.update(server.id, { environmentKeys: Object.keys(environment) })
        log.info(`Migrated local MCP environment values for "${server.name}" to secure storage.`)
      } catch (error) {
        // Never keep plaintext as a fallback. Disable the server and retain only
        // the key names so the user can re-enter values when secure storage works.
        mcpServerStore.update(server.id, {
          enabled: false,
          environmentKeys: Object.keys(environment)
        })
        log.error(
          `Secure storage was unavailable while migrating "${server.name}"; the server was disabled.`,
          error
        )
      }
    }
  }

  private handleUnexpectedClose(id: string, client: Client): void {
    const connection = this.connections.get(id)
    if (!connection || connection.client !== client) return
    this.connections.delete(id)
    this.setStatus({ id, status: 'error', error: 'The MCP server connection closed unexpectedly.' })
  }

  private async closeConnection(id: string): Promise<void> {
    const connection = this.connections.get(id)
    if (!connection) return
    this.connections.delete(id)
    try {
      await connection.client.close()
    } catch (error) {
      log.warn(`Error closing MCP server "${id}":`, error)
    }
  }

  private bumpAttempt(id: string): number {
    const next = (this.connectionAttempts.get(id) ?? 0) + 1
    this.connectionAttempts.set(id, next)
    return next
  }

  private setStatus(state: McpServerState): void {
    this.statuses.set(state.id, state)
    this.emit('statusChanged', state)
  }
}

export function toDescriptor(config: McpServerConfig, tool: McpToolInfo): McpToolDescriptor {
  const classification = classifyMcpTool(config, tool.annotations)
  return {
    serverId: config.id,
    serverName: config.name,
    toolName: tool.name,
    qualifiedName: `${config.id}__${tool.name}`,
    description: tool.description ?? '',
    inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {
      type: 'object',
      properties: {}
    },
    annotations: tool.annotations,
    ...classification
  }
}

function classifyMcpTool(
  config: McpServerConfig,
  annotations: McpToolAnnotations | undefined
): Pick<McpToolDescriptor, 'readOnly' | 'risk' | 'forceConfirm'> {
  // Tool annotations are hints. Only the built-in official GitHub preset is trusted
  // enough for them to reduce approval requirements; generic MCP stays sensitive.
  if (config.preset !== 'github') {
    return { readOnly: false, risk: 'sensitive', forceConfirm: false }
  }
  if (isGithubReadOnlyConfig(config) || annotations?.readOnlyHint === true) {
    return { readOnly: true, risk: 'safe', forceConfirm: false }
  }
  if (annotations?.destructiveHint === true) {
    return { readOnly: false, risk: 'destructive', forceConfirm: true }
  }
  return { readOnly: false, risk: 'sensitive', forceConfirm: true }
}

function isGithubReadOnlyConfig(config: McpServerConfig): boolean {
  if (config.type !== 'remote') return false
  const header = Object.entries(config.headers ?? {}).find(
    ([key]) => key.toLowerCase() === 'x-mcp-readonly'
  )?.[1]
  if (header && !['false', 'f', 'no', 'n', '0', 'off'].includes(header.trim().toLowerCase())) {
    return true
  }
  return /\/(?:readonly)(?:\/|$)/i.test(new URL(config.url).pathname)
}

/** Normalizes MCP content blocks and structured content into plain text for the model. */
export function normalizeToolResult(result: McpCallResult): string {
  const structured = result.structuredContent ?? result.toolResult
  let output: string
  if (structured !== undefined) {
    output = JSON.stringify(structured)
  } else {
    const blocks = Array.isArray(result.content) ? result.content : []
    output = blocks.map(describeContentBlock).filter(Boolean).join('\n') || '(no output)'
  }
  if (result.isError) return `Error: ${output === '(no output)' ? 'Tool call failed' : output}`
  return output
}

function describeContentBlock(block: unknown): string {
  if (!block || typeof block !== 'object' || !('type' in block)) return ''
  const typed = block as {
    type: string
    text?: string
    resource?: { text?: string; uri?: string }
  }
  if (typed.type === 'text') return typed.text ?? ''
  if (typed.type === 'resource') {
    return typed.resource?.text ?? `[resource: ${typed.resource?.uri ?? 'unknown'}]`
  }
  return `[${typed.type} content]`
}

export function mergeSecretEnvironment(
  existing: Record<string, string> | undefined,
  provided: Record<string, string> | undefined
): Record<string, string> {
  if (provided === undefined) return { ...existing }
  const next: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(provided)) {
    const key = rawKey.trim()
    if (!key) continue
    const value = rawValue.trim()
    if (value) next[key] = value
    else if (existing?.[key]) next[key] = existing[key]
  }
  return next
}

function cleanEnvironment(environment: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment ?? {})
      .map(([key, value]) => [key.trim(), value] as const)
      .filter(([key, value]) => Boolean(key && value))
  )
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

export const mcpManager = new McpManager()
