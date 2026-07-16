import { ipcMain } from 'electron'
import type { GithubConnectRequest } from '@shared/github.types'
import { IpcChannel } from '@shared/ipc'
import { err, ok, toErrorMessage } from '@shared/result'
import { githubService } from '../github/GitHubService'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:github')

export function registerGithubHandlers(): void {
  ipcMain.handle(IpcChannel.Github.getState, async (_event, projectId?: string | null) => {
    try {
      return ok(await githubService.getState(projectId))
    } catch (error) {
      log.warn('Failed to load GitHub state:', error)
      return err(
        'github.state-failed',
        'Could not load the GitHub connection.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(
    IpcChannel.Github.connect,
    async (_event, request: GithubConnectRequest, projectId?: string | null) => {
      try {
        return ok(await githubService.connect(request, projectId))
      } catch (error) {
        log.warn('Failed to connect GitHub:', error)
        return err('github.connect-failed', 'Could not connect GitHub.', toErrorMessage(error))
      }
    }
  )

  ipcMain.handle(IpcChannel.Github.disconnect, async (_event, projectId?: string | null) => {
    try {
      return ok(await githubService.disconnect(projectId))
    } catch (error) {
      log.warn('Failed to disconnect GitHub:', error)
      return err('github.disconnect-failed', 'Could not disconnect GitHub.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Github.detectRepository, async (_event, projectId: string) => {
    try {
      return ok(await githubService.detectRepository(projectId))
    } catch (error) {
      log.warn('Failed to detect the GitHub repository:', error)
      return err(
        'github.repository-detection-failed',
        'Could not detect the project repository.',
        toErrorMessage(error)
      )
    }
  })
}
