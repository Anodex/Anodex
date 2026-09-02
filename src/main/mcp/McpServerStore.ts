import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import type { McpLocalServerConfig, McpNewServerConfig, McpServerConfig } from '@shared/mcp.types'
import { createLogger } from '../utils/logger'
import { writeJsonFileAtomic } from '../utils/atomicJsonFile'

const log = createLogger('mcp:servers')

interface McpServersState {
  servers: McpServerConfig[]
}

const DEFAULT_STATE: McpServersState = { servers: [] }

/**
 * Persists configured MCP servers in Electron's `userData` directory, same
 * singleton-class + single-JSON-file pattern as `ProjectStore`. Holds
 * connection config only — no secrets (static tokens / OAuth records live in
 * `McpAuthStore`; local-server env vars, like other MCP hosts' local server
 * configs, are plain JSON since they're only ever passed to a locally
 * spawned child process on the user's own machine).
 */
class McpServerStore {
  private filePath = ''
  private cache: McpServersState | null = null

  /** Must be called after `app.whenReady()`. */
  init(): void {
    this.filePath = join(app.getPath('userData'), 'mcp-servers.json')
    this.cache = this.load()
    log.info('Initialised at', this.filePath)
  }

  list(): McpServerConfig[] {
    return this.getState().servers
  }

  get(id: string): McpServerConfig | undefined {
    return this.getState().servers.find((server) => server.id === id)
  }

  add(config: McpNewServerConfig): McpServerConfig {
    const state = this.getState()
    const withId = storedConfigFromNew(config, generateId())
    state.servers = [...state.servers, withId]
    this.persist(state)
    return withId
  }

  update(id: string, patch: Partial<McpServerConfig>): McpServerConfig {
    const state = this.getState()
    const index = state.servers.findIndex((server) => server.id === id)
    if (index === -1) throw new Error(`MCP server not found: ${id}`)
    const current = state.servers[index]
    if (patch.type && patch.type !== current.type) {
      throw new Error('Changing an MCP server transport requires replacing its configuration.')
    }
    const next = sanitizeStoredConfig({ ...current, ...patch } as McpServerConfig)
    state.servers = state.servers.map((server, i) => (i === index ? next : server))
    this.persist(state)
    return next
  }

  /** Fully replaces a server while preserving its id (used by managed presets such as GitHub). */
  replace(id: string, config: McpNewServerConfig): McpServerConfig {
    const state = this.getState()
    const index = state.servers.findIndex((server) => server.id === id)
    if (index === -1) throw new Error(`MCP server not found: ${id}`)
    const next = storedConfigFromNew(config, id)
    state.servers = state.servers.map((server, i) => (i === index ? next : server))
    this.persist(state)
    return next
  }

  remove(id: string): void {
    const state = this.getState()
    state.servers = state.servers.filter((server) => server.id !== id)
    this.persist(state)
  }

  private getState(): McpServersState {
    if (!this.cache) this.cache = this.load()
    return this.cache
  }

  private load(): McpServersState {
    if (!existsSync(this.filePath)) {
      this.persist(DEFAULT_STATE)
      return DEFAULT_STATE
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<McpServersState>
      return { servers: raw.servers ?? [] }
    } catch (error) {
      log.warn('Failed to parse MCP servers, falling back to defaults:', error)
      return DEFAULT_STATE
    }
  }

  private persist(state: McpServersState): void {
    try {
      const dir = app.getPath('userData')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const sanitized = { servers: state.servers.map(sanitizeStoredConfig) }
      writeJsonFileAtomic(this.filePath, sanitized)
      this.cache = sanitized
    } catch (error) {
      log.error('Failed to persist MCP servers:', error)
    }
  }
}

function storedConfigFromNew(config: McpNewServerConfig, id: string): McpServerConfig {
  if (config.type === 'remote') return sanitizeStoredConfig({ ...config, id })
  const { environment, ...stored } = config
  return sanitizeStoredConfig({
    ...stored,
    id,
    environmentKeys: Object.keys(environment ?? {})
  })
}

/** Defense in depth: persisted/IPC configs can contain secret names, never secret values. */
function sanitizeStoredConfig(config: McpServerConfig): McpServerConfig {
  if (config.type === 'remote') {
    return {
      id: config.id,
      name: config.name,
      enabled: config.enabled,
      type: 'remote',
      url: config.url,
      headers: config.headers,
      preset: config.preset
    }
  }
  const withPossibleLegacyEnvironment = config as McpLocalServerConfig & {
    environment?: Record<string, string>
  }
  return {
    id: withPossibleLegacyEnvironment.id,
    name: withPossibleLegacyEnvironment.name,
    enabled: withPossibleLegacyEnvironment.enabled,
    type: 'local',
    command: withPossibleLegacyEnvironment.command,
    cwd: withPossibleLegacyEnvironment.cwd,
    environmentKeys: withPossibleLegacyEnvironment.environmentKeys,
    preset: withPossibleLegacyEnvironment.preset
  }
}

function generateId(): string {
  return `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export const mcpServerStore = new McpServerStore()
