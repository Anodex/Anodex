import { ipcMain, shell } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { CreateProjectRequest, UpdateProjectRequest } from '@shared/project.types'
import { projectStore } from '../projects/ProjectStore'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:projects')

/** IPC handlers for project management. */
export function registerProjectHandlers(): void {
  ipcMain.handle(IpcChannel.Projects.list, () => projectStore.getState())

  ipcMain.handle(IpcChannel.Projects.listArchived, () => projectStore.listArchived())

  ipcMain.handle(IpcChannel.Projects.create, (_event, request: CreateProjectRequest) => {
    try {
      return projectStore.create(request)
    } catch (error) {
      log.error('Failed to create project:', error)
      throw new Error('Could not create project.')
    }
  })

  ipcMain.handle(
    IpcChannel.Projects.update,
    (_event, id: string, request: UpdateProjectRequest) => {
      try {
        return projectStore.update(id, request)
      } catch (error) {
        log.error('Failed to update project:', id, error)
        throw new Error('Could not update project.')
      }
    }
  )

  ipcMain.handle(IpcChannel.Projects.delete, (_event, id: string) => {
    try {
      projectStore.delete(id)
    } catch (error) {
      log.error('Failed to delete project:', id, error)
      throw new Error('Could not delete project.')
    }
  })

  ipcMain.handle(IpcChannel.Projects.restore, (_event, id: string) => {
    try {
      projectStore.restore(id)
    } catch (error) {
      log.error('Failed to restore project:', id, error)
      throw new Error('Could not restore project.')
    }
  })

  ipcMain.handle(IpcChannel.Projects.deletePermanent, (_event, id: string) => {
    try {
      projectStore.deletePermanent(id)
    } catch (error) {
      log.error('Failed to permanently delete project:', id, error)
      throw new Error('Could not permanently delete project.')
    }
  })

  ipcMain.handle(IpcChannel.Projects.setActive, (_event, id: string | null) => {
    try {
      return projectStore.setActive(id)
    } catch (error) {
      log.error('Failed to set active project:', id, error)
      throw new Error('Could not set active project.')
    }
  })

  ipcMain.handle(IpcChannel.Projects.openFolder, async (_event, id: string) => {
    try {
      const project = projectStore.getState().projects.find((p) => p.id === id)
      if (!project) throw new Error(`Project not found: ${id}`)
      const failure = await shell.openPath(project.folderPath)
      if (failure) throw new Error(failure)
    } catch (error) {
      log.error('Failed to open project folder:', id, error)
      throw new Error('Could not open project folder.')
    }
  })
}
