import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { err, ok, toErrorMessage } from '@shared/result'
import { projectStore } from '../projects/ProjectStore'
import {
  commitAll,
  createBranch,
  getGitWorkspaceStatus,
  initGitRepo,
  listBranches,
  pushBranch,
  switchBranch
} from '../git/gitWorkspace'
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

  ipcMain.handle(IpcChannel.Git.createBranch, async (_event, projectId: string, name: string) => {
    try {
      const folderPath = folderPathForProject(projectId)
      if (!folderPath) return err('git.no-project', 'No project folder to branch in.')
      return ok(await createBranch(folderPath, name))
    } catch (error) {
      log.warn('Failed to create git branch:', error)
      return err('git.branch-failed', 'Could not create the branch.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Git.listBranches, async (_event, projectId: string) => {
    try {
      const folderPath = folderPathForProject(projectId)
      if (!folderPath) return err('git.no-project', 'No project folder to list branches for.')
      return ok(await listBranches(folderPath))
    } catch (error) {
      log.warn('Failed to list git branches:', error)
      return err('git.list-branches-failed', 'Could not list branches.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Git.switchBranch, async (_event, projectId: string, name: string) => {
    try {
      const folderPath = folderPathForProject(projectId)
      if (!folderPath) return err('git.no-project', 'No project folder to switch branches in.')
      return ok(await switchBranch(folderPath, name))
    } catch (error) {
      log.warn('Failed to switch git branch:', error)
      return err('git.switch-branch-failed', 'Could not switch branches.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Git.commit, async (_event, projectId: string, message: string) => {
    try {
      const folderPath = folderPathForProject(projectId)
      if (!folderPath) return err('git.no-project', 'No project folder to commit in.')
      return ok(await commitAll(folderPath, message))
    } catch (error) {
      log.warn('Failed to commit:', error)
      return err('git.commit-failed', 'Could not commit.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Git.push, async (_event, projectId: string) => {
    try {
      const folderPath = folderPathForProject(projectId)
      if (!folderPath) return err('git.no-project', 'No project folder to push.')
      await pushBranch(folderPath)
      return ok(undefined)
    } catch (error) {
      log.warn('Failed to push:', error)
      return err('git.push-failed', 'Could not push.', toErrorMessage(error))
    }
  })
}
