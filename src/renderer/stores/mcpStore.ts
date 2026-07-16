import { create } from 'zustand'
import type {
  McpNewServerConfig,
  McpServerConfig,
  McpServerCredentials,
  McpServerPatch,
  McpServerState,
  McpToolDescriptor
} from '@shared/mcp.types'
import { anodex } from '../lib/anodex'
import { notifyError } from './uiStore'

interface McpState {
  servers: McpServerConfig[]
  statuses: Record<string, McpServerState>
  tools: McpToolDescriptor[]
  loaded: boolean
  load: () => Promise<void>
  add: (
    config: McpNewServerConfig,
    credentials?: McpServerCredentials
  ) => Promise<McpServerConfig | null>
  update: (id: string, patch: McpServerPatch, credentials?: McpServerCredentials) => Promise<void>
  remove: (id: string) => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  setStaticToken: (id: string, token: string) => Promise<void>
  connect: (id: string) => Promise<void>
  testConnection: (
    config: McpServerConfig
  ) => Promise<{ ok: true; toolCount: number } | { ok: false; error: string } | null>
  disconnectAuth: (id: string) => Promise<void>
  refreshTools: () => Promise<void>
  /** Called by the IPC bridge when the main process broadcasts a status change. */
  setStatus: (state: McpServerState) => void
}

/** Mirrors configured MCP servers, their live connection status, and discovered tools. */
export const useMcpStore = create<McpState>((set, get) => ({
  servers: [],
  statuses: {},
  tools: [],
  loaded: false,

  load: async () => {
    const [servers, statuses, tools] = await Promise.all([
      anodex.mcp.list(),
      anodex.mcp.getStatuses(),
      anodex.mcp.listTools()
    ])
    const statusMap: Record<string, McpServerState> = {}
    for (const status of statuses) statusMap[status.id] = status
    set({ servers, statuses: statusMap, tools, loaded: true })
  },

  add: async (config, credentials) => {
    try {
      const result = await anodex.mcp.add(config, credentials)
      if (!result.ok) {
        notifyError('Could not add MCP server', result.error.message)
        return null
      }
      set((state) => ({ servers: [...state.servers, result.value] }))
      return result.value
    } catch (error) {
      notifyError('Could not add MCP server', error instanceof Error ? error.message : undefined)
      return null
    }
  },

  update: async (id, patch, credentials) => {
    try {
      const result = await anodex.mcp.update(id, patch, credentials)
      if (!result.ok) {
        notifyError('Could not update MCP server', result.error.message)
        return
      }
      set((state) => ({
        servers: state.servers.map((server) => (server.id === id ? result.value : server))
      }))
    } catch (error) {
      notifyError('Could not update MCP server', error instanceof Error ? error.message : undefined)
    }
  },

  remove: async (id) => {
    try {
      const result = await anodex.mcp.remove(id)
      if (!result.ok) {
        notifyError('Could not remove MCP server', result.error.message)
        return
      }
      set((state) => {
        const { [id]: _removed, ...statuses } = state.statuses
        return {
          servers: state.servers.filter((server) => server.id !== id),
          statuses,
          tools: state.tools.filter((tool) => tool.serverId !== id)
        }
      })
    } catch (error) {
      notifyError('Could not remove MCP server', error instanceof Error ? error.message : undefined)
    }
  },

  setEnabled: async (id, enabled) => {
    await get().update(id, { enabled })
    await get().refreshTools()
  },

  setStaticToken: async (id, token) => {
    try {
      const result = await anodex.mcp.setStaticToken(id, token)
      if (!result.ok) notifyError('Could not save the access token', result.error.message)
      await get().refreshTools()
    } catch (error) {
      notifyError(
        'Could not save the access token',
        error instanceof Error ? error.message : undefined
      )
    }
  },

  connect: async (id) => {
    try {
      const result = await anodex.mcp.connect(id)
      if (!result.ok) notifyError('Could not connect to the MCP server', result.error.message)
      await get().refreshTools()
    } catch (error) {
      notifyError(
        'Could not connect to the MCP server',
        error instanceof Error ? error.message : undefined
      )
    }
  },

  testConnection: async (config) => {
    try {
      const result = await anodex.mcp.testConnection(config)
      if (!result.ok) {
        notifyError('Connection test failed', result.error.message)
        return null
      }
      return result.value
    } catch (error) {
      notifyError('Connection test failed', error instanceof Error ? error.message : undefined)
      return null
    }
  },

  disconnectAuth: async (id) => {
    try {
      const result = await anodex.mcp.disconnectAuth(id)
      if (!result.ok) notifyError('Could not disconnect', result.error.message)
      await get().refreshTools()
    } catch (error) {
      notifyError('Could not disconnect', error instanceof Error ? error.message : undefined)
    }
  },

  refreshTools: async () => {
    const tools = await anodex.mcp.listTools()
    set({ tools })
  },

  setStatus: (status) => {
    set((state) => ({ statuses: { ...state.statuses, [status.id]: status } }))
    // Connecting removes the previous live client immediately, and every
    // terminal state may add or drop tools. Keep catalog/chat availability
    // synchronized even when a server dies and transitions directly to error.
    void get().refreshTools()
  }
}))
