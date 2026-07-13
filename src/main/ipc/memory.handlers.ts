import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { ok, err, toErrorMessage } from '@shared/result'
import type { CreateMemoryRequest, MemoryScope, UpdateMemoryRequest } from '@shared/memory.types'
import { memoryStore } from '../memory/MemoryStore'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:memory')

/** IPC handlers for the structured memory store (Settings → Memory). */
export function registerMemoryHandlers(): void {
  ipcMain.handle(IpcChannel.Memory.list, (_event, projectId: string | null) => {
    try {
      return ok(memoryStore.listAll(projectId, { includeArchived: true }))
    } catch (error) {
      log.error('Failed to list memory:', error)
      return err('memory.list-failed', 'Could not read memory entries.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Memory.create, (_event, request: CreateMemoryRequest) => {
    try {
      return ok(memoryStore.create(request))
    } catch (error) {
      log.error('Failed to create memory entry:', error)
      return err(
        'memory.create-failed',
        'Could not create the memory entry.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(
    IpcChannel.Memory.update,
    (_event, scope: MemoryScope, id: string, patch: UpdateMemoryRequest) => {
      try {
        return ok(memoryStore.update(scope, id, patch))
      } catch (error) {
        log.error('Failed to update memory entry:', id, error)
        return err(
          'memory.update-failed',
          'Could not update the memory entry.',
          toErrorMessage(error)
        )
      }
    }
  )

  ipcMain.handle(IpcChannel.Memory.delete, (_event, scope: MemoryScope, id: string) => {
    try {
      memoryStore.delete(scope, id)
      return ok(undefined)
    } catch (error) {
      log.error('Failed to delete memory entry:', id, error)
      return err(
        'memory.delete-failed',
        'Could not delete the memory entry.',
        toErrorMessage(error)
      )
    }
  })
}
