import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type {
  CreateScheduledTaskRequest,
  UpdateScheduledTaskRequest
} from '@shared/scheduledTask.types'
import { parseWhen } from '@shared/parseWhen'
import { isRemoteCall } from '../clients/clientRegistry'
import { schedulerStore } from '../scheduler/SchedulerStore'
import { schedulerService } from '../scheduler/SchedulerService'
import { setKeepAwake } from '../scheduler/keepAwake'
import { settingsStore } from '../settings/SettingsStore'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:scheduler')

/**
 * A task created from a phone gets no tools.
 *
 * `headlessConfirm` lets an unattended run auto-approve anything that is not
 * destructive and does not require a person, and it says why in as many words:
 * "the tool set was already narrowed to what the user opted in". That sentence
 * was true while the only way to pick a tool set was the editor on this machine.
 * Making `scheduler:create` reachable from a phone made it false — the caller
 * choosing the tools and the person who would have vetted them stopped being the
 * same party, and the run happens with nobody watching.
 *
 * So the narrowing is enforced here rather than trusted from the request. The
 * phone's own client already sends an empty list; this is the difference between
 * that being a convention on one client and a property of the channel.
 *
 * A task that genuinely needs tools is still made at the computer, where the list
 * of what it may touch is on screen in front of the person granting it.
 */
function withoutRemoteTools(
  event: unknown,
  request: CreateScheduledTaskRequest
): CreateScheduledTaskRequest {
  if (!isRemoteCall(event)) return request
  if (request.enabledTools.length > 0) {
    log.warn(
      `refused ${request.enabledTools.length} tool(s) on a task created remotely; ` +
        'tools are granted at the computer'
    )
  }
  return { ...request, enabledTools: [] }
}

/** IPC handlers for scheduled task management. */
export function registerSchedulerHandlers(): void {
  ipcMain.handle(IpcChannel.Scheduler.list, () => {
    const tasks = schedulerStore.list()
    // Logged because a phone showing an empty scheduler and a computer holding a
    // task could not be told apart from either end: the handler answers the same
    // way whether it was never asked or asked and had nothing. One line here names
    // which, and costs nothing — this is read when somebody opens a screen, not in
    // any loop.
    log.info(`scheduler:list answered with ${tasks.length} task(s)`)
    return tasks
  })

  // Null for anything it cannot read, rather than an error: the caller previews
  // this on every keystroke, and half-typed input is the normal state of a field
  // somebody is still filling in, not a fault to report.
  ipcMain.handle(IpcChannel.Scheduler.parseWhen, (_event, text: string) =>
    typeof text === 'string' ? parseWhen(text) : null
  )

  ipcMain.handle(IpcChannel.Scheduler.create, (event, request: CreateScheduledTaskRequest) => {
    try {
      return schedulerStore.create(withoutRemoteTools(event, request))
    } catch (error) {
      log.error('Failed to create scheduled task:', error)
      throw new Error('Could not create scheduled task.')
    }
  })

  ipcMain.handle(
    IpcChannel.Scheduler.update,
    (event, id: string, request: UpdateScheduledTaskRequest) => {
      try {
        // Same rule by the other door: granting tools to a task that already
        // exists is granting tools. Undefined rather than an empty array, so a
        // remote edit of the name or schedule leaves whatever was granted at the
        // computer alone instead of silently stripping it.
        const safe = isRemoteCall(event) ? { ...request, enabledTools: undefined } : request
        return schedulerStore.update(id, safe)
      } catch (error) {
        log.error('Failed to update scheduled task:', id, error)
        throw new Error('Could not update scheduled task.')
      }
    }
  )

  ipcMain.handle(IpcChannel.Scheduler.delete, (_event, id: string) => {
    schedulerStore.delete(id)
  })

  ipcMain.handle(IpcChannel.Scheduler.runNow, async (_event, id: string) => {
    try {
      await schedulerService.runNow(id)
    } catch (error) {
      log.error('Failed to run scheduled task now:', id, error)
      throw error instanceof Error ? error : new Error('Could not run this task.')
    }
  })

  ipcMain.handle(IpcChannel.Scheduler.getKeepAwake, () => settingsStore.get().scheduler.keepAwake)

  ipcMain.handle(IpcChannel.Scheduler.setKeepAwake, (_event, value: boolean) => {
    settingsStore.update({ scheduler: { keepAwake: value } })
    setKeepAwake(value)
    return value
  })
}
