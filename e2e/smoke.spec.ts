import { test, expect, _electron as electron } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnodexApi } from '../src/shared/ipc'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

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

test('persisted visual inspection screenshots reopen inside the conversation', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'anodex-visual-preview-e2e-'))
  const conversationId = 'visual-preview-test'
  const assetId = 'message-1-preview.png'
  const assetDir = join(userDataDir, 'conversation-assets', conversationId)
  const conversationDir = join(userDataDir, 'conversations', 'general')
  const preview = {
    kind: 'image' as const,
    title: 'Rendered page.html',
    path: 'page.html',
    mimeType: 'image/png',
    asset: { conversationId, id: assetId }
  }
  const call = {
    id: 'tool-1',
    name: 'inspect_visual',
    kind: 'read' as const,
    title: 'Inspect page.html',
    detail: 'HTML screenshot attached',
    status: 'success' as const,
    preview
  }
  await mkdir(assetDir, { recursive: true })
  await mkdir(conversationDir, { recursive: true })
  await writeFile(join(assetDir, assetId), ONE_PIXEL_PNG)
  await writeFile(
    join(conversationDir, `${conversationId}.json`),
    JSON.stringify({
      id: conversationId,
      projectId: null,
      title: 'Visual preview test',
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          content: 'The page is ready.',
          createdAt: 1,
          toolCalls: [call],
          blocks: [
            { type: 'tool', call },
            { type: 'text', text: 'The page is ready.' }
          ]
        }
      ],
      createdAt: 1,
      updatedAt: 1
    })
  )
  await writeFile(
    join(userDataDir, 'conversations', 'state.json'),
    JSON.stringify({ activeConversationId: conversationId })
  )

  const app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userDataDir}`]
  })

  try {
    const mainWindow = await app.firstWindow()
    const image = mainWindow.getByAltText('Visual inspection of page.html')
    await expect(image).toBeVisible()
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/)

    await mainWindow.getByRole('button', { name: 'Open Rendered page.html fullscreen' }).click()
    await expect(
      mainWindow.getByRole('dialog', { name: 'Fullscreen image: Rendered page.html' })
    ).toBeVisible()
    await mainWindow.getByRole('button', { name: 'Zoom in' }).click()
    await expect(
      mainWindow.getByRole('button', { name: 'Reset zoom, currently 125%' })
    ).toBeVisible()
    await mainWindow.keyboard.press('Escape')
    await expect(
      mainWindow.getByRole('dialog', { name: 'Fullscreen image: Rendered page.html' })
    ).not.toBeVisible()
  } finally {
    await app.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('persisted uploaded images reopen inline in user messages', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'anodex-inline-image-e2e-'))
  const conversationId = 'inline-attachment-test'
  const conversationDir = join(userDataDir, 'conversations', 'general')
  const imagePath = join(userDataDir, 'robot.png')

  await mkdir(conversationDir, { recursive: true })
  await writeFile(imagePath, ONE_PIXEL_PNG)
  await writeFile(
    join(conversationDir, `${conversationId}.json`),
    JSON.stringify({
      id: conversationId,
      projectId: null,
      title: 'Inline attachment test',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'What is in this image?',
          createdAt: 1,
          attachments: [
            {
              path: imagePath,
              name: 'robot.png',
              sizeBytes: ONE_PIXEL_PNG.length,
              kind: 'image',
              mimeType: 'image/png'
            }
          ]
        }
      ],
      createdAt: 1,
      updatedAt: 1
    })
  )
  await writeFile(
    join(userDataDir, 'conversations', 'state.json'),
    JSON.stringify({ activeConversationId: conversationId })
  )

  const app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userDataDir}`]
  })

  try {
    const mainWindow = await app.firstWindow()
    const image = mainWindow.getByAltText('robot.png')
    await expect(image).toBeVisible()
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/)

    const openButton = mainWindow.getByRole('button', { name: 'Open robot.png fullscreen' })
    await openButton.click()
    await expect(
      mainWindow.getByRole('dialog', { name: 'Fullscreen image: robot.png' })
    ).toBeVisible()
    await mainWindow.getByRole('button', { name: 'Close fullscreen image' }).click()
    await expect(openButton).toBeFocused()
  } finally {
    await app.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})
