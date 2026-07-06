import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { CreateProjectRequest, UpdateProjectRequest } from '@shared/project.types'
import { projectStore } from '../projects/ProjectStore'

/** IPC handlers for project management. */
export function registerProjectHandlers(): void {
  ipcMain.handle(IpcChannel.Projects.list, () => projectStore.getState())

  ipcMain.handle(IpcChannel.Projects.create, (_event, request: CreateProjectRequest) =>
    projectStore.create(request)
  )

  ipcMain.handle(IpcChannel.Projects.update, (_event, id: string, request: UpdateProjectRequest) =>
    projectStore.update(id, request)
  )

  ipcMain.handle(IpcChannel.Projects.delete, (_event, id: string) => projectStore.delete(id))

  ipcMain.handle(IpcChannel.Projects.setActive, (_event, id: string | null) =>
    projectStore.setActive(id)
  )
}
