import { BrowserWindow, ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type {
  ApproveCriticalThinkingRequest,
  CreateCriticalThinkingRequest,
  ExportCriticalThinkingPdfRequest
} from '@shared/criticalThinking.types'
import { criticalThinkingService } from '../criticalThinking/CriticalThinkingService'
import { criticalThinkingStore } from '../criticalThinking/CriticalThinkingStore'
import { exportCriticalThinkingPdf } from '../criticalThinking/criticalThinkingPdf'

export function registerCriticalThinkingHandlers(): void {
  ipcMain.handle(IpcChannel.CriticalThinking.list, () => criticalThinkingStore.list())
  ipcMain.handle(
    IpcChannel.CriticalThinking.create,
    (_event, request: CreateCriticalThinkingRequest) => criticalThinkingService.start(request)
  )
  ipcMain.handle(
    IpcChannel.CriticalThinking.approve,
    (_event, id: string, request: ApproveCriticalThinkingRequest) =>
      criticalThinkingService.approve(id, request)
  )
  ipcMain.handle(IpcChannel.CriticalThinking.stop, (_event, id: string) =>
    criticalThinkingService.stop(id)
  )
  ipcMain.handle(IpcChannel.CriticalThinking.delete, (_event, id: string) =>
    criticalThinkingService.delete(id)
  )
  ipcMain.handle(
    IpcChannel.CriticalThinking.exportPdf,
    (event, request: ExportCriticalThinkingPdfRequest) =>
      exportCriticalThinkingPdf(BrowserWindow.fromWebContents(event.sender), request)
  )
}
