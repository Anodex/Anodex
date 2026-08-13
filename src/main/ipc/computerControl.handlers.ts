import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { StartComputerControlRequest } from '@shared/computerControl.types'
import { err, ok, toErrorMessage } from '@shared/result'
import { broadcastToWindows } from '../broadcast'
import { computerControlService } from '../computerControl/ComputerControlService'
import { createAnodexFileViewerControlTarget } from '../computerControl/AnodexFileViewerControlTarget'
import { desktopControlEligibility } from '../computerControl/DesktopControlPolicy'
import { computerControlOverlay } from '../computerControl/ControlOverlayWindow'
import { WindowsDesktopControlTarget } from '../computerControl/WindowsDesktopControlTarget'
import { windowsDesktopControlBackend } from '../computerControl/WindowsDesktopControlBackend'
import { createHtmlPreviewControlTarget } from '../htmlPreviewWindow'
import { llamaService } from '../llama/LlamaService'
import { settingsStore } from '../settings/SettingsStore'

function broadcast(conversationId: string): void {
  broadcastToWindows(IpcChannel.ComputerControl.changed, computerControlService.get(conversationId))
}

/** User-owned lifecycle actions for the single visible preview session. */
export function registerComputerControlHandlers(): void {
  ipcMain.handle(
    IpcChannel.ComputerControl.start,
    async (_event, request: StartComputerControlRequest) => {
      try {
        if (!isVisionCapableActiveProvider()) {
          return err(
            'computer-control.vision-required',
            'Enable a vision-capable model before AI control.'
          )
        }
        if (request.target === 'desktop') {
          const eligibility = desktopControlEligibility(
            settingsStore.get().computerControl,
            process.platform,
            windowsDesktopControlBackend.isAvailable()
          )
          if (!eligibility.available) {
            return err(
              'computer-control.desktop-unavailable',
              eligibility.reason ?? 'Desktop control is unavailable.'
            )
          }
          if (!request.desktopWindowHandle) {
            return err(
              'computer-control.desktop-target-required',
              'Choose a desktop window before enabling desktop control.'
            )
          }
          const selected = (await windowsDesktopControlBackend.listWindows()).find(
            (window) => window.handle === request.desktopWindowHandle
          )
          if (!selected) {
            return err(
              'computer-control.desktop-target-unavailable',
              'The selected desktop window is no longer available or is protected.'
            )
          }
          const session = await computerControlService.start(
            request.conversationId,
            new WindowsDesktopControlTarget(selected, windowsDesktopControlBackend)
          )
          computerControlOverlay.sync(session)
          broadcast(request.conversationId)
          return ok(session)
        }
        const target =
          request.target === 'file-viewer'
            ? createAnodexFileViewerControlTarget()
            : request.previewPath
              ? createHtmlPreviewControlTarget(
                  request.previewPath,
                  request.scope === 'project-preview' ? 'project-preview' : 'single-preview'
                )
              : null
        if (!target) {
          return err(
            'computer-control.target-not-available',
            request.target === 'file-viewer'
              ? 'Open the Anodex File Viewer first.'
              : 'Open the project HTML preview window first.'
          )
        }
        const session = await computerControlService.start(request.conversationId, target)
        computerControlOverlay.sync(session)
        broadcast(request.conversationId)
        return ok(session)
      } catch (error) {
        return err(
          'computer-control.start-failed',
          'Could not start AI control.',
          toErrorMessage(error)
        )
      }
    }
  )

  ipcMain.handle(IpcChannel.ComputerControl.pause, (_event, conversationId: string) => {
    try {
      const session = computerControlService.pause(conversationId)
      broadcast(conversationId)
      return ok(session)
    } catch (error) {
      return err(
        'computer-control.pause-failed',
        'Could not pause AI control.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.ComputerControl.resume, (_event, conversationId: string) => {
    try {
      const session = computerControlService.resume(conversationId)
      broadcast(conversationId)
      return ok(session)
    } catch (error) {
      return err(
        'computer-control.resume-failed',
        'Could not resume AI control.',
        toErrorMessage(error)
      )
    }
  })

  ipcMain.handle(IpcChannel.ComputerControl.stop, (_event, conversationId: string) => {
    const session = computerControlService.stopConversation(conversationId, 'user-stop')
    broadcast(conversationId)
    return ok(session)
  })

  ipcMain.handle(IpcChannel.ComputerControl.get, (_event, conversationId: string) =>
    computerControlService.get(conversationId)
  )

  ipcMain.handle(IpcChannel.ComputerControl.listDesktopTargets, async () => {
    const eligibility = desktopControlEligibility(
      settingsStore.get().computerControl,
      process.platform,
      windowsDesktopControlBackend.isAvailable()
    )
    if (!eligibility.available) {
      return err(
        'computer-control.desktop-unavailable',
        eligibility.reason ?? 'Desktop control is unavailable.'
      )
    }
    try {
      return ok(await windowsDesktopControlBackend.listWindows())
    } catch (error) {
      return err(
        'computer-control.desktop-list-failed',
        'Could not list desktop windows.',
        toErrorMessage(error)
      )
    }
  })
}

function isVisionCapableActiveProvider(): boolean {
  const active = settingsStore.get().provider.active
  return active !== 'local' || Boolean(llamaService.getState().vision)
}
