import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type {
  CheckpointPreview,
  CheckpointRequest,
  RollbackCheckpointsRequest,
  RestoreCheckpointRequest,
  UndoCheckpointRequest
} from '@shared/checkpoint.types'
import { err, ok, toErrorMessage } from '@shared/result'
import { projectStore } from '../projects/ProjectStore'
import { checkpointStore } from '../checkpoints/CheckpointStore'
import { isRemoteCall } from '../clients/clientRegistry'

/**
 * The same inspection, minus the file contents.
 *
 * A checkpoint carries the whole before and after of every file a message
 * touched. That is right for the renderer, which draws a diff from it and lives on
 * the same machine — and wrong to put on a socket, where one turn that rewrote a
 * large file becomes a frame too big to send, and the phone gets nothing at all
 * rather than a slightly smaller answer.
 *
 * What survives is what a phone can use: which files changed, how, and by how
 * much. Reading one is a separate request it can already make, against the file as
 * it now stands.
 */
function withoutFileContents(preview: CheckpointPreview): CheckpointPreview {
  return {
    ...preview,
    files: preview.files.map((file) => ({ ...file, before: null, after: null }))
  }
}

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

  ipcMain.handle(IpcChannel.Checkpoints.inspect, (event, request: CheckpointRequest) => {
    const project = projectStore.getState().projects.find((item) => item.id === request.projectId)
    if (!project) return err('checkpoint.no-project', 'That project is no longer available.')
    try {
      const preview = checkpointStore.inspect(
        project.folderPath,
        request.conversationId,
        request.messageId
      )
      return ok(isRemoteCall(event) ? withoutFileContents(preview) : preview)
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
