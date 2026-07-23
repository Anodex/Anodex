import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import { ok, err, toErrorMessage } from '@shared/result'
import { broadcastToWindows } from '../broadcast'
import { terminalService } from '../terminal/TerminalService'
import { settingsStore } from '../settings/SettingsStore'
import { createLogger } from '../utils/logger'

const log = createLogger('ipc:terminal')

export function registerTerminalHandlers(): void {
  ipcMain.handle(IpcChannel.Terminal.create, () => {
    try {
      // Same source every other workspace-facing handler reads from
      // (see workspace.handlers.ts) — the terminal should open where the
      // user's project actually is, not wherever Electron's own process
      // happens to be running from.
      const cwd = settingsStore.get().workspace.root || undefined
      const sessionId = terminalService.create(cwd)
      return ok(sessionId)
    } catch (error) {
      log.error('Failed to start terminal:', error)
      return err('terminal.create-failed', 'Could not start terminal.', toErrorMessage(error))
    }
  })

  ipcMain.handle(IpcChannel.Terminal.write, (_event, sessionId: string, data: string) => {
    terminalService.write(sessionId, data)
  })

  ipcMain.handle(
    IpcChannel.Terminal.resize,
    (_event, sessionId: string, cols: number, rows: number) => {
      terminalService.resize(sessionId, cols, rows)
    }
  )

  ipcMain.handle(IpcChannel.Terminal.kill, (_event, sessionId: string) => {
    terminalService.kill(sessionId)
  })

  const broadcast = broadcastToWindows

  terminalService.onData((payload) => {
    broadcast(IpcChannel.Terminal.data, payload)
  })

  terminalService.onExit((payload) => {
    broadcast(IpcChannel.Terminal.exit, payload)
  })
}
