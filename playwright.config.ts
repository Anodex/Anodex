import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for Anodex E2E smoke tests.
 *
 * These tests launch the built Electron app: `smoke.spec.ts` checks specific
 * screens, `journeys.spec.ts` the paths a person takes through the app. Run with
 * `npm run build && npm run test:e2e`; CI runs them on Linux under xvfb.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  // Each test launches the whole app, which takes several seconds before the
  // first click; a CI runner can be several times slower than a desktop.
  timeout: 90_000,
  // Once in CI, so a trace exists for a failure (see `trace` below). Locally a
  // failure should be looked at, not retried.
  retries: process.env.CI ? 1 : 0,
  use: {
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'electron',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
})
