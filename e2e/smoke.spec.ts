import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnodexApi } from '../src/shared/ipc'

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

test('GitHub settings exposes the guided hosted-MCP setup', async () => {
  const app = await electron.launch({
    args: ['out/main/index.js']
  })

  try {
    const window = await app.firstWindow()
    await window.getByRole('button', { name: 'Settings', exact: true }).click()
    await window.getByRole('button', { name: 'GitHub' }).click()

    await expect(window.getByRole('heading', { name: 'GitHub', exact: true })).toBeVisible()
    await expect(window.getByText("GitHub's official hosted MCP server")).toBeVisible()
    await expect(window.getByRole('button', { name: 'Connect GitHub' })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('past user messages open the edit and regenerate review', async ({
  browserName: _browserName
}, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'anodex-edit-message-e2e-'))
  const app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userDataDir}`]
  })

  try {
    const mainWindow = await app.firstWindow()
    await expect(mainWindow).toHaveTitle(/Anodex/)
    await mainWindow.evaluate(async () => {
      const anodex = (globalThis as unknown as { anodex: AnodexApi }).anodex
      const now = Date.now()
      await anodex.conversations.save({
        id: 'edit-message-test',
        projectId: null,
        title: 'Edit message test',
        messages: [
          { id: 'u1', role: 'user', content: 'Build the first version', createdAt: now },
          {
            id: 'a1',
            role: 'assistant',
            content: 'The first version is ready.',
            createdAt: now + 1
          }
        ],
        createdAt: now,
        updatedAt: now
      })
      await anodex.conversations.setState({ activeConversationId: 'edit-message-test' })
    })
    await mainWindow.reload()

    await mainWindow.getByRole('button', { name: 'Edit message', exact: true }).click()
    await expect(
      mainWindow.getByRole('heading', { name: 'Edit message', exact: true })
    ).toBeVisible()
    await expect(mainWindow.getByRole('textbox', { name: 'Message text' })).toHaveValue(
      'Build the first version'
    )
    await expect(mainWindow.getByRole('button', { name: 'Update & regenerate' })).toBeVisible()

    await mainWindow.setViewportSize({ width: 520, height: 760 })
    await expect(mainWindow.getByRole('dialog', { name: 'Edit message' })).toBeInViewport()
    await mainWindow.waitForTimeout(250)
    await mainWindow.screenshot({ path: testInfo.outputPath('edit-message-dialog.png') })
  } finally {
    await app.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})
