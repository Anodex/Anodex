import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { err, ok, toErrorMessage } from '@shared/result'
import type { WebSearchTestConfig } from '@shared/settings.types'
import { testSearchProvider } from '../tools/search/testSearchProvider'

/** IPC for setting up web search. */
export function registerWebSearchHandlers(): void {
  ipcMain.handle(IpcChannel.WebSearch.test, async (_event, config: WebSearchTestConfig) => {
    try {
      return ok({ resultCount: await testSearchProvider(config) })
    } catch (error) {
      return err('web-search.test-failed', toErrorMessage(error))
    }
  })
}
