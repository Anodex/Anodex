import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { CreateAgentRunRequest } from '@shared/agentRun.types'
import { agentRunStore } from '../agents/AgentRunStore'
import { agentRunService } from '../agents/AgentRunService'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:agent')

/** IPC handlers for agent run management. */
export function registerAgentHandlers(): void {
  ipcMain.handle(IpcChannel.Agent.list, () => agentRunStore.list())

  ipcMain.handle(IpcChannel.Agent.create, (_event, request: CreateAgentRunRequest) => {
    try {
      return agentRunService.start(request)
    } catch (error) {
      log.error('Failed to start agent run:', error)
      throw error instanceof Error ? error : new Error('Could not start this run.')
    }
  })

  ipcMain.handle(IpcChannel.Agent.stop, (_event, id: string) => {
    try {
      agentRunService.stop(id)
    } catch (error) {
      log.error('Failed to stop agent run:', id, error)
      throw error instanceof Error ? error : new Error('Could not stop this run.')
    }
  })

  ipcMain.handle(IpcChannel.Agent.delete, (_event, id: string) => {
    if (agentRunStore.get(id)?.status === 'running') {
      throw new Error('Stop this run before deleting it.')
    }
    agentRunStore.delete(id)
  })

  ipcMain.handle(IpcChannel.Agent.approvePlan, (_event, id: string) => {
    try {
      agentRunService.approvePlan(id)
    } catch (error) {
      log.error('Failed to approve agent run plan:', id, error)
      throw error instanceof Error ? error : new Error('Could not approve this plan.')
    }
  })

  ipcMain.handle(IpcChannel.Agent.rejectPlan, (_event, id: string) => {
    try {
      agentRunService.rejectPlan(id)
    } catch (error) {
      log.error('Failed to reject agent run plan:', id, error)
      throw error instanceof Error ? error : new Error('Could not reject this plan.')
    }
  })
}
