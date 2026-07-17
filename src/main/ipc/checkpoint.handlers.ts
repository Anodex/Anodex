import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { CheckpointRequest, RestoreCheckpointRequest } from '@shared/checkpoint.types'
import { err, ok, toErrorMessage } from '@shared/result'
import { projectStore } from '../projects/ProjectStore'
import { checkpointStore } from '../checkpoints/CheckpointStore'

export function registerCheckpointHandlers(): void {
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
}
