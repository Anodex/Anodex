import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { ok, err, toErrorMessage } from '@shared/result'
import type { ChartGranularity, ChartRange } from '@shared/stats.types'
import { tokenActivityStore } from '../stats/TokenActivityStore'

/** IPC handlers for all-time token-activity usage stats. */
export function registerStatsHandlers(): void {
  ipcMain.handle(IpcChannel.Stats.getUsageProfile, () => {
    try {
      return ok(tokenActivityStore.getUsageProfile())
    } catch (error) {
      return err('stats.load-failed', 'Could not read token usage data.', toErrorMessage(error))
    }
  })

  ipcMain.handle(
    IpcChannel.Stats.getUsageBreakdown,
    (_event, range: ChartRange, granularity: ChartGranularity) => {
      try {
        return ok(tokenActivityStore.getUsageBreakdown(range, granularity))
      } catch (error) {
        return err('stats.load-failed', 'Could not read token usage data.', toErrorMessage(error))
      }
    }
  )
}
