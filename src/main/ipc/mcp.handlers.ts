import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { ok, err, toErrorMessage } from '@shared/result'
import type {
  McpNewServerConfig,
  McpServerConfig,
  McpServerCredentials,
  McpServerPatch
} from '@shared/mcp.types'
import { mcpManager } from '../mcp/McpManager'
import { mcpServerStore } from '../mcp/McpServerStore'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:mcp')

export function registerMcpHandlers(): void {
  ipcMain.handle(IpcChannel.Mcp.list, () => mcpServerStore.list())

  ipcMain.handle(
    IpcChannel.Mcp.add,
    (_event, config: McpNewServerConfig, credentials?: McpServerCredentials) => {
      try {
        return ok(mcpManager.addServer(config, credentials))
      } catch (error) {
        log.warn('Failed to add MCP server:', error)
        return err('mcp.add-failed', 'Could not add the MCP server.', toErrorMessage(error))
      }
    }
  )

  ipcMain.handle(
    IpcChannel.Mcp.update,
    async (_event, id: string, patch: McpServerPatch, credentials?: McpServerCredentials) => {
      try {
        return ok(await mcpManager.updateServer(id, patch, credentials))
      } catch (error) {
        log.warn('Failed to update MCP server:', error)
        return err('mcp.update-failed', 'Could not update the MCP server.', toErrorMessage(error))
      }
    }
  )

  ipcMain.handle(IpcChannel.Mcp.remove, async (_event, id: string) => {
    try {
      await mcpManager.removeServer(id)
      return ok(undefined)
    } catch (error) {
      log.warn('Failed to remove MCP server:', error)
      return err('mcp.remove-failed', 'Could not remove the MCP server.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Mcp.setEnabled, async (_event, id: string, enabled: boolean) => {
    try {
      return ok(await mcpManager.setEnabled(id, enabled))
    } catch (error) {
      log.warn('Failed to toggle MCP server:', error)
      return err(
        'mcp.set-enabled-failed',
        'Could not update the MCP server.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.Mcp.setStaticToken, async (_event, id: string, token: string) => {
    try {
      await mcpManager.setStaticToken(id, token)
      return ok(undefined)
    } catch (error) {
      log.warn('Failed to store MCP server token:', error)
      return err('mcp.set-token-failed', 'Could not store the access token.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Mcp.connect, async (_event, id: string) => {
    try {
      const config = mcpServerStore.get(id)
      if (!config) throw new Error(`MCP server not found: ${id}`)
      await mcpManager.connectServer(config)
      return ok(undefined)
    } catch (error) {
      log.warn('Failed to connect MCP server:', error)
      return err(
        'mcp.connect-failed',
        'Could not connect to the MCP server.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.Mcp.testConnection, async (_event, config: McpServerConfig) => {
    try {
      return ok(await mcpManager.testConnection(config))
    } catch (error) {
      log.warn('Failed to test MCP server connection:', error)
      return err(
        'mcp.test-connection-failed',
        'Could not test the MCP server connection.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.Mcp.disconnectAuth, async (_event, id: string) => {
    try {
      await mcpManager.disconnectAuth(id)
      return ok(undefined)
    } catch (error) {
      log.warn('Failed to disconnect MCP server auth:', error)
      return err(
        'mcp.disconnect-auth-failed',
        'Could not disconnect the MCP server.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.Mcp.getStatuses, () => mcpManager.getAllStatuses())

  ipcMain.handle(IpcChannel.Mcp.listTools, () => mcpManager.listTools())
}
