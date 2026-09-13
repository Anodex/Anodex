import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { CreateAgentRunRequest } from '@shared/agentRun.types'
import { buildRunToolNames } from '@shared/tools.types'
import { agentRunStore } from '../agents/AgentRunStore'
import { agentRunService } from '../agents/AgentRunService'
import { discardRunAttachments } from '../agents/agentRunAttachments'
import { isRemoteCall } from '../clients/clientRegistry'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:agent')

/**
 * A run started from away: the phone says what to build, this decides what with.
 *
 * An agent run is the most capable thing in Anodex — it edits real files and runs
 * real commands, for a long time, without being watched. Starting one from a phone
 * is exactly what the phone is *for*, so this is not about refusing it; it is about
 * being precise on which half of the request is the caller's to make.
 *
 * The goal is theirs. The tool set is not. `enabledTools` arrives from a client and
 * is clamped to the same vetted list the editor on this machine offers by default —
 * so a phone can ask for less (a look-only run is a subset), and cannot name
 * anything outside it. `buildRunToolNames` already excludes everything requiring a
 * person and everything off-topic for a build.
 *
 * `requirePlan` is forced on for the same reason. It is the human gate: the run
 * plans, stops, and waits to be approved — and the phone can already show a plan
 * and answer it. A caller able to switch that off could start unattended work on
 * real files with no review anywhere in the loop, which is the one thing worth
 * holding back.
 */
function startedFromAway(request: CreateAgentRunRequest): CreateAgentRunRequest {
  const vetted = new Set(buildRunToolNames())
  const asked = request.enabledTools ?? []
  const allowed = asked.filter((name) => vetted.has(name))

  const refused = asked.length - allowed.length
  if (refused > 0) {
    log.warn(`refused ${refused} tool(s) on a run started remotely; not in the build set`)
  }
  // A path in a request from away is a request to read that file off this
  // machine, and nothing on the phone picks files for a run. Dropped rather
  // than trusted until something does, and then only from the upload folder.
  if (request.attachments?.length) {
    log.warn(`dropped ${request.attachments.length} attachment(s) on a run started remotely`)
  }

  return {
    ...request,
    // An empty ask is a run that could do nothing at all, which is a worse answer
    // than the default the desktop would have offered for the same goal.
    enabledTools: allowed.length > 0 ? allowed : [...vetted],
    requirePlan: true,
    attachments: undefined
  }
}

/** IPC handlers for agent run management. */
export function registerAgentHandlers(): void {
  ipcMain.handle(IpcChannel.Agent.list, () => agentRunStore.list())

  ipcMain.handle(IpcChannel.Agent.create, async (event, request: CreateAgentRunRequest) => {
    try {
      return await agentRunService.start(isRemoteCall(event) ? startedFromAway(request) : request)
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

  ipcMain.handle(IpcChannel.Agent.delete, async (_event, id: string) => {
    if (agentRunStore.get(id)?.status === 'running') {
      throw new Error('Stop this run before deleting it.')
    }
    agentRunStore.delete(id)
    await discardRunAttachments(id)
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
