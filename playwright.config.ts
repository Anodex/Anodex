import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for Anodex E2E smoke tests.
 *
 * These tests launch the packaged/built Electron app and verify that the main
 * window opens and core UI elements are present. Run with `npm run test:e2e`.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
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
