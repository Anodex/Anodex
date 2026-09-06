import { ipcMain, shell } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { broadcastToWindows } from '../broadcast'
import { hasInflightGeneration } from '../chat/inflightGenerations'
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

  ipcMain.handle(IpcChannel.Projects.archive, (_event, id: string) => {
    try {
      projectStore.archive(id)
    } catch (error) {
      log.error('Failed to archive project:', id, error)
      throw new Error('Could not archive project.')
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
    // There is one active project and it is global state: `setActive` writes
    // `settings.workspace.root`. Switching mid-generation pulls the workspace out
    // from under a live turn, which is breakage rather than a surprise — and it
    // matters most when the switch came from a phone, because nobody is watching
    // the machine it happens on (§10.1).
    if (hasInflightGeneration()) {
      throw new Error(
        'Anodex is working on something right now. Wait for it to finish before switching project.'
      )
    }

    try {
      const state = projectStore.setActive(id)

      // A switch can now come from a phone, so the desktop has to be told rather
      // than assuming it was the one that asked. Never swap silently (§10.1).
      broadcastToWindows(IpcChannel.Projects.changed, state)
      return state
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
