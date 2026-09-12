import { EventEmitter } from 'node:events'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateDownloadedEvent } from 'electron-updater'
import type { UpdateStatus } from '@shared/update.types'
import { createLogger } from '../utils/logger'
import { verifyUpdateFile } from './verifyRelease'

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
  /** Last version `update-available` named. `download-progress` doesn't repeat it. */
  private pendingVersion: string | null = null

  init(): void {
    if (this.initialized) return
    this.initialized = true

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('checking-for-update', () => this.setStatus({ state: 'checking' }))
    autoUpdater.on('update-available', (info) => {
      this.pendingVersion = info.version
      this.setStatus({ state: 'available', version: info.version })
    })
    autoUpdater.on('update-not-available', () => this.setStatus({ state: 'not-available' }))
    autoUpdater.on('download-progress', (progress) =>
      this.setStatus({
        state: 'downloading',
        version: this.pendingVersion ?? app.getVersion(),
        percent: Math.round(progress.percent)
      })
    )
    autoUpdater.on('update-downloaded', (event) => {
      this.pendingVersion = event.version
      void this.verifyDownload(event)
    })
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

  /**
   * Checks a finished download against the release signing key before it is
   * offered as installable.
   *
   * This runs here rather than through electron-updater's own
   * `verifyUpdateCodeSignature` hook for two reasons: that hook is Windows-only,
   * and it is skipped entirely when the app is unsigned, so on this build it
   * would never fire. Gating our own `downloaded` state covers all three
   * platforms and stays correct if the app is code-signed later, when the
   * platform check becomes an additional layer rather than a replacement.
   *
   * `installAndRestart` only acts on `downloaded`, and `autoInstallOnAppQuit`
   * is off, so a rejected file has no path to being run.
   */
  private async verifyDownload(event: UpdateDownloadedEvent): Promise<void> {
    this.setStatus({ state: 'verifying', version: event.version })

    let verdict: Awaited<ReturnType<typeof verifyUpdateFile>>
    try {
      verdict = await verifyUpdateFile({
        downloadedFile: event.downloadedFile,
        version: event.version,
        files: event.files
      })
    } catch (error) {
      // An unexpected failure is still a failure to verify. Refuse rather than
      // fall through to `downloaded`.
      verdict = { verdict: 'rejected', reason: (error as Error).message }
    }

    if (verdict.verdict === 'rejected') {
      log.error(`Refusing update ${event.version}: ${verdict.reason}`)
      this.setStatus({ state: 'rejected', version: event.version, reason: verdict.reason })
      return
    }

    if (verdict.verdict === 'unenforced') {
      log.warn(`Update ${event.version} installed without a signature check — ${verdict.reason}`)
    }

    this.setStatus({ state: 'downloaded', version: event.version })
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
