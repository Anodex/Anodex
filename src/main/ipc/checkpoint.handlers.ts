import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type {
  CheckpointRequest,
  RollbackCheckpointsRequest,
  RestoreCheckpointRequest,
  UndoCheckpointRequest
} from '@shared/checkpoint.types'
import { err, ok, toErrorMessage } from '@shared/result'
import { projectStore } from '../projects/ProjectStore'
import { checkpointStore } from '../checkpoints/CheckpointStore'

export function registerCheckpointHandlers(): void {
  ipcMain.handle(IpcChannel.Checkpoints.list, (_event, projectId: string) => {
    const project = projectStore.getState().projects.find((item) => item.id === projectId)
    if (!project) return err('checkpoint.no-project', 'That project is no longer available.')
    try {
      return ok(checkpointStore.list(project.folderPath))
    } catch (error) {
      return err(
        'checkpoint.list-failed',
        'Could not load checkpoint history.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.Checkpoints.inspect, (_event, request: CheckpointRequest) => {
    const project = projectStore.getState().projects.find((item) => item.id === request.projectId)
    if (!project) return err('checkpoint.no-project', 'That project is no longer available.')
    try {
      return ok(
        checkpointStore.inspect(project.folderPath, request.conversationId, request.messageId)
      )
    } catch (error) {
      return err(
        'checkpoint.inspect-failed',
        'Could not inspect that checkpoint.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.Checkpoints.restore, (_event, request: RestoreCheckpointRequest) => {
    const project = projectStore.getState().projects.find((item) => item.id === request.projectId)
    if (!project) return err('checkpoint.no-project', 'That project is no longer available.')
    try {
      return ok(
        checkpointStore.restore(project.folderPath, request.conversationId, request.messageId, {
          paths: request.paths,
          force: request.force
        })
      )
    } catch (error) {
      return err(
        'checkpoint.restore-failed',
        'Could not restore that checkpoint.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.Checkpoints.undo, (_event, request: UndoCheckpointRequest) => {
    const project = projectStore.getState().projects.find((item) => item.id === request.projectId)
    if (!project) return err('checkpoint.no-project', 'That project is no longer available.')
    try {
      return ok(
        checkpointStore.undoRestore(project.folderPath, request.conversationId, request.messageId, {
          paths: request.paths,
          force: request.force
        })
      )
    } catch (error) {
      return err('checkpoint.undo-failed', 'Could not undo that restore.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Checkpoints.rollback, (_event, request: RollbackCheckpointsRequest) => {
    const project = projectStore.getState().projects.find((item) => item.id === request.projectId)
    if (!project) return err('checkpoint.no-project', 'That project is no longer available.')
    try {
      return ok(
        checkpointStore.rollback(project.folderPath, request.conversationId, request.messageIds, {
          excludePaths: request.excludePaths,
          force: request.force
        })
      )
    } catch (error) {
      return err(
        'checkpoint.rollback-failed',
        'Could not roll back the discarded turns.',
        toErrorMessage(error)
      )
    }
  })
}
