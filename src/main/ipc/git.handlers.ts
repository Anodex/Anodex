import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { err, ok, toErrorMessage } from '@shared/result'
import { projectStore } from '../projects/ProjectStore'
import { getGitWorkspaceStatus, initGitRepo } from '../git/gitWorkspace'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:git')

function folderPathForProject(projectId: string): string | null {
  return (
    projectStore.getState().projects.find((project) => project.id === projectId)?.folderPath ?? null
  )
}

export function registerGitHandlers(): void {
  ipcMain.handle(IpcChannel.Git.getStatus, async (_event, projectId: string) => {
    try {
      const folderPath = folderPathForProject(projectId)
      if (!folderPath) return err('git.no-project', 'No project folder to check.')
      return ok(await getGitWorkspaceStatus(folderPath))
    } catch (error) {
      log.warn('Failed to read git status:', error)
      return err('git.status-failed', 'Could not read the git status.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Git.init, async (_event, projectId: string) => {
    try {
      const folderPath = folderPathForProject(projectId)
      if (!folderPath) return err('git.no-project', 'No project folder to initialize.')
      return ok(await initGitRepo(folderPath))
    } catch (error) {
      log.warn('Failed to initialize git repository:', error)
      return err('git.init-failed', 'Could not initialize the repository.', toErrorMessage(error))
    }
  })
}
