import { EventEmitter } from 'node:events'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '@shared/update.types'
import { createLogger } from '../utils/logger'

const log = createLogger('updater')

/**
 * Thin wrapper around `electron-updater`, following the same
 * EventEmitter('state', ...) + broadcast-to-all-windows pattern already used
 * by `LlamaService` for engine state. Downloads are never automatic — the
 * user approves the download and the restart-to-install separately, matching
 * this app's general "ask before a disruptive action" convention rather than
 * silently restarting mid-session.
 *
 * Only meaningful in a packaged build: `electron-updater` reads
 * `app-update.yml`, which electron-builder only generates for a real
 * packaged app, so this is a no-op in dev.
 */
class UpdateService extends EventEmitter {
  private status: UpdateStatus = { state: 'idle' }
  private initialized = false

  init(): void {
    if (this.initialized) return
    this.initialized = true

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('checking-for-update', () => this.setStatus({ state: 'checking' }))
    autoUpdater.on('update-available', (info) =>
      this.setStatus({ state: 'available', version: info.version })
    )
    autoUpdater.on('update-not-available', () => this.setStatus({ state: 'not-available' }))
    autoUpdater.on('download-progress', (progress) =>
      this.setStatus({ state: 'downloading', percent: Math.round(progress.percent) })
    )
    autoUpdater.on('update-downloaded', (info) =>
      this.setStatus({ state: 'downloaded', version: info.version })
    )
    autoUpdater.on('error', (error) => {
      log.warn('Update check failed:', error)
      this.setStatus({ state: 'error', message: error.message })
    })
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  /** No-op outside a packaged build — there's nothing meaningful to check against in dev. */
  async check(): Promise<void> {
    if (!app.isPackaged) {
      log.debug('Skipping update check in an unpackaged (dev) build')
      return
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      // Already surfaced via the 'error' event above; this catch only stops
      // an unhandled rejection from a check nothing in the UI awaited.
      log.warn('checkForUpdates threw:', error)
    }
  }

  async download(): Promise<void> {
    if (this.status.state !== 'available') return
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      log.warn('downloadUpdate threw:', error)
    }
  }

  /** Quits and installs the already-downloaded update. Only valid after `downloaded`. */
  installAndRestart(): void {
    if (this.status.state !== 'downloaded') return
    autoUpdater.quitAndInstall()
  }

  private setStatus(status: UpdateStatus): void {
    this.status = status
    this.emit('status', status)
  }
}

export const updateService = new UpdateService()
