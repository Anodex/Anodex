import { test, expect, _electron as electron } from '@playwright/test'

/**
 * Smoke test: launch the built Electron app and verify the main window
 * appears with the expected title.
 *
 * Requires `npm run build` first so that `out/main/index.js` exists.
 */
test('app launches and shows the main window', async () => {
  const app = await electron.launch({
    args: ['out/main/index.js']
  })

  try {
    const window = await app.firstWindow()
    await expect(window).toHaveTitle(/Anodex/)
  } finally {
    await app.close()
  }
})

test('app shell does not render nested buttons', async () => {
  const app = await electron.launch({
    args: ['out/main/index.js']
  })

  try {
    const window = await app.firstWindow()
    await expect(window).toHaveTitle(/Anodex/)
    await expect(window.locator('button button')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
