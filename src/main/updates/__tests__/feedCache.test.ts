import { describe, expect, it, vi } from 'vitest'

/**
 * The update check asks the origin rather than a cache.
 *
 * Reported as "check for updates said I was current, then the same button found
 * it later". That is exactly what a cached feed looks like from the outside.
 *
 * `latest.yml` is a GitHub release asset, and release assets are served through
 * a CDN. A response to this very feed came back `X-Cache: MISS, HIT` with
 * `Age: 499` — eight minutes stale. So for some minutes after a release, the
 * check is answered with the previous version's file, and Anodex correctly
 * reports that it is up to date.
 *
 * `requestHeaders` is the one knob electron-updater exposes for this, so it is
 * worth a test: it is a single assignment in `init`, it has no visible effect
 * when it is right, and removing it brings the bug back silently.
 */

const autoUpdater = vi.hoisted(() => ({
  autoDownload: true,
  autoInstallOnAppQuit: true,
  requestHeaders: null as Record<string, string> | null,
  on: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn()
}))

vi.mock('electron-updater', () => ({ autoUpdater }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0', getPath: () => '.' }
}))
vi.mock('../../broadcast', () => ({ broadcastToWindows: vi.fn() }))
vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: { get: () => ({ updates: { automatic: false } }) }
}))
vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() })
}))
vi.mock('../../diagnostics', () => ({
  diagnosticsReporter: { report: vi.fn(), resolved: vi.fn() }
}))

const { updateService } = await import('../UpdateService')

describe('the update feed', () => {
  it('is fetched with a revalidation request, not from a cache', () => {
    updateService.init()

    expect(autoUpdater.requestHeaders).toMatchObject({ 'Cache-Control': 'no-cache' })
  })
})
