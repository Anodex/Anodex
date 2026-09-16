import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What `settings.updates.automatic` actually does: download without being asked,
 * then install at the first moment nothing is running — and nothing at all when
 * it is off.
 */
const h = vi.hoisted(() => ({
  automatic: false,
  quiet: true,
  listeners: new Map<string, (payload: never) => void>(),
  downloadUpdate: vi.fn(() => Promise.resolve([])),
  checkForUpdates: vi.fn(() => Promise.resolve(null)),
  quitAndInstall: vi.fn(),
  progressWindow: vi.fn(() => Promise.resolve(undefined)),
  verify: vi.fn((): Promise<{ verdict: 'signed' | 'unenforced' | 'rejected'; reason?: string }> =>
    Promise.resolve({ verdict: 'signed' })
  ),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.9.22', getPath: () => 'C:/Anodex/Anodex.exe', isPackaged: true }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: (event: string, listener: (payload: never) => void) => h.listeners.set(event, listener),
    checkForUpdates: h.checkForUpdates,
    downloadUpdate: h.downloadUpdate,
    quitAndInstall: h.quitAndInstall
  }
}))

vi.mock('../../utils/logger', () => ({ createLogger: () => h.log }))
vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: { get: () => ({ updates: { automatic: h.automatic } }) }
}))
vi.mock('../verifyRelease', () => ({ verifyUpdateFile: h.verify }))
vi.mock('../updateProgressWindow', () => ({ showUpdateProgressWindow: h.progressWindow }))
vi.mock('../quietMoment', () => ({ nothingInFlight: () => h.quiet }))

/**
 * A fresh service per test. The singleton is deliberately one-way once an install
 * starts — it is about to quit the app — so a second test cannot reuse it.
 */
let updateService: (typeof import('../UpdateService'))['updateService']

/** Drive the updater's own events, the way electron-updater would. */
const announce = (event: string, payload?: unknown): void => {
  h.listeners.get(event)?.(payload as never)
}

const downloadFinished = async (version = '0.9.23'): Promise<void> => {
  announce('update-downloaded', { version, downloadedFile: 'Anodex-Setup.exe', files: [] })
  // `verifyDownload` is awaited inside the listener, so let it settle.
  await vi.waitFor(() => expect(updateService.getStatus().state).toBe('downloaded'))
}

beforeEach(async () => {
  vi.useFakeTimers()
  h.automatic = false
  h.quiet = true
  h.listeners.clear()
  h.downloadUpdate.mockClear()
  h.quitAndInstall.mockClear()
  h.progressWindow.mockClear()
  vi.resetModules()
  updateService = (await import('../UpdateService')).updateService
  updateService.init()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('when updates install themselves', () => {
  it('downloads a new version without being asked', () => {
    h.automatic = true

    announce('update-available', { version: '0.9.23' })

    expect(h.downloadUpdate).toHaveBeenCalled()
  })

  it('installs as soon as it is downloaded and nothing is running', async () => {
    h.automatic = true

    await downloadFinished()

    expect(h.quitAndInstall).toHaveBeenCalled()
  })

  it('waits while something is running, and installs when it stops', async () => {
    h.automatic = true
    h.quiet = false

    await downloadFinished()
    expect(h.quitAndInstall).not.toHaveBeenCalled()

    // A minute later, still busy.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.quitAndInstall).not.toHaveBeenCalled()

    h.quiet = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.quitAndInstall).toHaveBeenCalled()
  })

  it('stops waiting if the setting is turned off again', async () => {
    h.automatic = true
    h.quiet = false
    await downloadFinished()

    h.automatic = false
    h.quiet = true
    await vi.advanceTimersByTimeAsync(60_000)

    expect(h.quitAndInstall).not.toHaveBeenCalled()
  })
})

describe('when they do not', () => {
  it('leaves the download to the user', () => {
    announce('update-available', { version: '0.9.23' })

    expect(h.downloadUpdate).not.toHaveBeenCalled()
    expect(updateService.getStatus()).toEqual({ state: 'available', version: '0.9.23' })
  })

  it('leaves a downloaded update sitting there', async () => {
    await downloadFinished()

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.quitAndInstall).not.toHaveBeenCalled()
  })
})

describe('an update that failed its signature check', () => {
  it('is never installed, asked for or not', async () => {
    h.automatic = true
    h.verify.mockResolvedValueOnce({ verdict: 'rejected', reason: 'signature mismatch' })

    announce('update-downloaded', {
      version: '0.9.23',
      downloadedFile: 'Anodex-Setup.exe',
      files: []
    })
    await vi.waitFor(() => expect(updateService.getStatus().state).toBe('rejected'))

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.quitAndInstall).not.toHaveBeenCalled()
  })
})
