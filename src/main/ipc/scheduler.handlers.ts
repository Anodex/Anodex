import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type {
  CreateScheduledTaskRequest,
  UpdateScheduledTaskRequest
} from '@shared/scheduledTask.types'
import { parseWhen } from '@shared/parseWhen'
import { schedulerStore } from '../scheduler/SchedulerStore'
import { schedulerService } from '../scheduler/SchedulerService'
import { setKeepAwake } from '../scheduler/keepAwake'
import { settingsStore } from '../settings/SettingsStore'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:scheduler')

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

  ipcMain.handle(IpcChannel.Scheduler.create, (_event, request: CreateScheduledTaskRequest) => {
    try {
      return schedulerStore.create(request)
    } catch (error) {
      log.error('Failed to create scheduled task:', error)
      throw new Error('Could not create scheduled task.')
    }
  })

  ipcMain.handle(
    IpcChannel.Scheduler.update,
    (_event, id: string, request: UpdateScheduledTaskRequest) => {
      try {
        return schedulerStore.update(id, request)
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
