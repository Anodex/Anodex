import { expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Wait for the boot overlay to let go before touching anything.
 *
 * `StartupOverlay` covers the window while the app hydrates. A test that clicks
 * before it clears is clicking the starfield, not the app.
 */
export async function waitForStartup(window: Page): Promise<void> {
  // Attach first: `firstWindow()` resolves before React has mounted, so a bare
  // count-of-zero would pass against an empty document.
  await window.waitForSelector('[data-state]', { state: 'attached', timeout: 10_000 })
  await expect(window.locator('[data-state]')).toHaveCount(0, { timeout: 30_000 })
}

/** A launched app on its own throwaway profile, and every page error it raised. */
export interface FreshApp {
  app: ElectronApplication
  window: Page
  userDataDir: string
  pageErrors: string[]
  /** Quit, keeping the profile so a test can launch again on it. */
  quit: () => Promise<void>
  /** Quit and delete the profile. */
  dispose: () => Promise<void>
}

/**
 * Launch the built app on a fresh profile, or on `userDataDir` to relaunch one.
 *
 * Always a temporary profile: a journey that opened the person's own would read
 * and write their real chats and settings.
 */
export async function launchFresh(userDataDir?: string): Promise<FreshApp> {
  const dir = userDataDir ?? (await mkdtemp(join(tmpdir(), 'anodex-journey-')))
  const app = await electron.launch({ args: [`--user-data-dir=${dir}`, 'out/main/index.js'] })
  const window = await app.firstWindow()
  const pageErrors: string[] = []
  window.on('pageerror', (error) => pageErrors.push(error.message))
  await waitForStartup(window)
  const quit = async (): Promise<void> => {
    await app.close()
  }
  return {
    app,
    window,
    userDataDir: dir,
    pageErrors,
    quit,
    dispose: async () => {
      await app.close().catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    }
  }
}

/** Nothing on screen says a section crashed. */
export async function expectNoCrash(window: Page): Promise<void> {
  await expect(window.getByText(/hit an error$/)).toHaveCount(0)
  await expect(window.getByText('Something went wrong')).toHaveCount(0)
}
