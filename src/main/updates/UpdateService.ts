import { EventEmitter } from 'node:events'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateDownloadedEvent } from 'electron-updater'
import type { UpdateStatus } from '@shared/update.types'
import { createLogger } from '../utils/logger'
import { settingsStore } from '../settings/SettingsStore'
import { verifyUpdateFile } from './verifyRelease'
import { nothingInFlight } from './quietMoment'
import { showUpdateProgressWindow } from './updateProgressWindow'
import { diagnosticsReporter } from '../diagnostics/DiagnosticsReporter'

const log = createLogger('updater')

/** How often an update waiting for a quiet moment looks again. */
const QUIET_CHECK_MS = 60_000

/** How often a long-running app asks whether there is a new version, when it installs them itself. */
const RECHECK_MS = 3 * 60 * 60_000

/**
 * Thin wrapper around `electron-updater`, following the same
 * EventEmitter('state', ...) + broadcast-to-all-windows pattern already used
 * by `LlamaService` for engine state. Downloads are never automatic — the
 * user approves the download and the restart-to-install separately, matching
 * this app's general "ask before a disruptive action" convention rather than
 * silently restarting mid-session.
 *
 * Unless they asked for the opposite. `settings.updates.automatic` is off by
 * default and, when on, means exactly what it says: the download starts by
 * itself and the install happens at the first moment nothing is running (see
 * `quietMoment.ts`). It is for a machine left working unattended, where the
 * alternative is what happened here — four releases waiting on a click while
 * the work that needed them carried on against the old build. The signature
 * check is untouched by it: `installAndRestart` still acts only on
 * `downloaded`, which a rejected file never reaches.
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

    // Ask the origin, not whatever a cache remembers.
    //
    // The feed is `latest.yml`, a GitHub release asset, and release assets are
    // served through a CDN: a response to this very check came back
    // `X-Cache: MISS, HIT` with `Age: 499`, meaning eight minutes stale. So for
    // several minutes after a release, "check for updates" is answered with the
    // *previous* version's file and the app correctly reports that it is
    // current. Pressing the button again later finds it, which is exactly what
    // it looks like from the outside: a button that does not work the first time.
    //
    // A revalidation request is the standard way to say "not from a cache", and
    // the check runs at most a few times a day, so nothing is lost by asking.
    autoUpdater.requestHeaders = { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }

    autoUpdater.on('checking-for-update', () => this.setStatus({ state: 'checking' }))
    autoUpdater.on('update-available', (info) => {
      this.pendingVersion = info.version
      this.setStatus({ state: 'available', version: info.version })
      if (this.automatic()) {
        log.info(`Downloading ${info.version} — updates are set to install by themselves`)
        void this.download()
      }
    })
    autoUpdater.on('update-not-available', () =>
      this.setStatus({ state: 'not-available', checkedAt: Date.now() })
    )
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

    // Anodex is checked once at launch, which is enough for an app somebody opens
    // and closes. A machine left working stays open for days, and an update it
    // never hears about is one it cannot install by itself — so while this is on,
    // ask again through the day.
    const recheck = setInterval(() => {
      if (this.automatic() && this.status.state !== 'downloaded') void this.check()
    }, RECHECK_MS)
    recheck.unref?.()
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
    if (this.automatic()) this.installWhenNothingIsRunning()
  }

  /**
   * Install as soon as a restart would cost nothing, checking again every minute
   * until then.
   *
   * No deadline, and nothing is ever interrupted to make room: a machine that is
   * busy for a day updates a day later, which is the whole bargain of leaving this
   * on. The waiting is said out loud once per attempt, so a version that never
   * seems to install can be explained from the log rather than guessed at.
   */
  private installWhenNothingIsRunning(options?: { atOnce?: boolean }): void {
    if (this.waitingForQuiet || this.installing) return
    this.waitingForQuiet = true

    const attempt = (): void => {
      if (this.status.state !== 'downloaded' || !this.automatic()) {
        this.stopWaitingForQuiet()
        return
      }
      if (!nothingInFlight()) {
        log.info(`Holding ${this.status.version} back: something is still running`)
        return
      }
      this.stopWaitingForQuiet()
      log.info(`Installing ${this.status.version} — nothing is running`)
      void this.installAndRestart()
    }

    this.quietCheck = setInterval(attempt, QUIET_CHECK_MS)
    this.quietCheck.unref?.()
    if (options?.atOnce !== false) attempt()
  }

  /**
   * Act on the setting having just been turned on.
   *
   * An update already sitting downloaded is installed at the next quiet moment
   * rather than this one: somebody who has just this second ticked the box is at
   * the keyboard, and an app that vanishes on the same click reads as a fault
   * however clearly the box was labelled. A minute is enough to mean "because you
   * asked" instead.
   */
  automaticTurnedOn(): void {
    if (!this.automatic()) return
    if (this.status.state === 'downloaded') {
      this.installWhenNothingIsRunning({ atOnce: false })
      return
    }
    if (this.status.state === 'available') {
      void this.download()
      return
    }
    void this.check()
  }

  private stopWaitingForQuiet(): void {
    if (this.quietCheck) clearInterval(this.quietCheck)
    this.quietCheck = null
    this.waitingForQuiet = false
  }

  /** Whether the user has asked for updates to install by themselves. */
  private automatic(): boolean {
    return settingsStore.get().updates?.automatic === true
  }

  /**
   * Quits and installs the already-downloaded update. Only valid after `downloaded`.
   *
   * Silent, and relaunching afterwards. The Windows installer is the assisted
   * kind (`oneClick: false`), so run normally it opens on "who should this be
   * installed for?" and waits there — Anodex has already quit, so nothing comes
   * back until someone finds that window and clicks through it. The user agreed to
   * the install by pressing Restart & install; the upgrade keeps the existing
   * per-user installation and its folder either way.
   */
  async installAndRestart(): Promise<void> {
    if (this.status.state !== 'downloaded' || this.installing) return
    // A second press while the window is starting must not start a second install.
    this.installing = true
    // Silent means nothing on screen while it installs, so say it is happening —
    // waiting until the window is up, so Anodex never vanishes with nothing in its place.
    await showUpdateProgressWindow({ version: this.status.version, exePath: app.getPath('exe') })
    autoUpdater.quitAndInstall(true, true)
  }

  private installing = false
  private waitingForQuiet = false
  private quietCheck: ReturnType<typeof setInterval> | null = null

  private setStatus(status: UpdateStatus): void {
    this.status = status
    // Either answer means the check reached the server, which is the part that
    // fails on a flaky connection and then quietly starts working again.
    if (status.state === 'available' || status.state === 'not-available') {
      diagnosticsReporter.resolved('updater')
    }
    this.emit('status', status)
  }
}

export const updateService = new UpdateService()
