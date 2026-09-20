import { test, expect, _electron as electron } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnodexApi } from '../src/shared/ipc'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

/**
 * Wait for the boot overlay to let go before touching anything.
 *
 * `StartupOverlay` covers the window while the app hydrates, and covering is
 * its job — the real shell renders underneath from the first frame, and an
 * opaque backdrop over a half-hydrated app is the point. Measured, it clears
 * about eight seconds after launch.
 *
 * A test that starts clicking before then is not testing anything: the click
 * lands on the starfield. Waiting for the overlay to unmount is the same
 * thing a person does by looking at the screen.
 */
async function waitForStartup(window: Page): Promise<void> {
  // Attach first: `firstWindow()` resolves before React has mounted, so a
  // bare count-of-zero would pass against an empty document.
  await window.waitForSelector('[data-state]', { state: 'attached', timeout: 10_000 })
  await expect(window.locator('[data-state]')).toHaveCount(0, { timeout: 30_000 })
}

/**
 * Open every collapsed turn-activity panel.
 *
 * A reopened conversation renders its turns folded — `TurnRecap` starts
 * collapsed for anything that isn't actively streaming, so the transcript
 * reads as replies rather than scaffolding. The panel is `overflow: hidden`
 * at zero height, so the tool cards inside it still report a bounding box and
 * still satisfy `toBeVisible()`, but nothing in them can be clicked.
 *
 * Anything asserting on tool output in a persisted chat therefore has to do
 * what a reader does first: open the turn.
 */
async function expandTurnActivity(window: Page): Promise<void> {
  const collapsed = window.getByRole('button', { name: 'Show turn activity' })
  for (let guard = 0; guard < 10; guard += 1) {
    if ((await collapsed.count()) === 0) return
    await collapsed.first().click()
  }
  throw new Error('turn activity panels never finished expanding')
}

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
    await waitForStartup(window)
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
    await waitForStartup(window)
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
    await waitForStartup(mainWindow)

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
  const beforeAssetId = 'message-1-before.png'
  const assetId = 'message-1-preview.png'
  const shownAssetId = 'message-1-shown.png'
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
  const beforeCall = {
    ...call,
    id: 'tool-before',
    title: 'Inspect page.html before edit',
    preview: {
      ...preview,
      title: 'Before page edit',
      asset: { conversationId, id: beforeAssetId }
    }
  }
  const shownCall = {
    id: 'tool-shown',
    name: 'show_image',
    kind: 'read' as const,
    title: 'Show result.png',
    detail: 'image shown in conversation',
    status: 'success' as const,
    preview: {
      kind: 'image' as const,
      source: 'assistant' as const,
      title: 'result.png',
      path: 'result.png',
      mimeType: 'image/png',
      asset: { conversationId, id: shownAssetId }
    }
  }
  await mkdir(assetDir, { recursive: true })
  await mkdir(conversationDir, { recursive: true })
  await writeFile(join(assetDir, beforeAssetId), ONE_PIXEL_PNG)
  await writeFile(join(assetDir, assetId), ONE_PIXEL_PNG)
  await writeFile(join(assetDir, shownAssetId), ONE_PIXEL_PNG)
  await writeFile(
    join(conversationDir, `${conversationId}.json`),
    JSON.stringify({
      id: conversationId,
      projectId: null,
      title: 'Visual preview test',
      messages: [
        {
          id: 'message-before',
          role: 'assistant',
          content: 'Here is the first inspection.',
          createdAt: 1,
          toolCalls: [beforeCall],
          blocks: [
            { type: 'tool', call: beforeCall },
            { type: 'text', text: 'Here is the first inspection.' }
          ]
        },
        {
          id: 'request-change',
          role: 'user',
          content: 'Change the page and inspect it again.',
          createdAt: 2
        },
        {
          id: 'message-after',
          role: 'assistant',
          content: 'The updated page is ready.',
          createdAt: 3,
          toolCalls: [call, shownCall],
          blocks: [
            { type: 'tool', call },
            { type: 'tool', call: shownCall },
            { type: 'text', text: 'The updated page is ready.' }
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
    await waitForStartup(mainWindow)
    await expandTurnActivity(mainWindow)
    const image = mainWindow.getByAltText('Visual inspection of page.html').last()
    await expect(image).toBeVisible()
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/)

    const openFullscreen = mainWindow.getByRole('button', {
      name: 'Open Rendered page.html fullscreen'
    })
    await openFullscreen.scrollIntoViewIfNeeded()
    await openFullscreen.click()
    await expect(
      mainWindow.getByRole('dialog', { name: 'Fullscreen image: Rendered page.html' })
    ).toBeVisible()
    await mainWindow.getByRole('button', { name: 'Zoom in' }).click()
    await expect(
      mainWindow.getByRole('button', { name: 'Reset zoom, currently 125%' })
    ).toBeVisible()
    await expect(mainWindow.getByRole('button', { name: 'Copy image' })).toBeVisible()
    await expect(mainWindow.getByRole('button', { name: 'Save image' })).toBeVisible()
    await mainWindow.keyboard.press('Escape')
    await expect(
      mainWindow.getByRole('dialog', { name: 'Fullscreen image: Rendered page.html' })
    ).not.toBeVisible()

    await expect(
      mainWindow.getByRole('button', { name: 'Compare latest inspections' })
    ).toHaveAttribute('aria-expanded', 'true')
    await expect(mainWindow.getByAltText('Before: page.html')).toBeVisible()
    await expect(mainWindow.getByAltText('After: page.html')).toBeVisible()
    await expect(mainWindow.getByAltText('Assistant image of result.png')).toBeVisible()

    const beforePane = mainWindow.getByLabel('Before screenshot of page.html')
    const afterPane = mainWindow.getByLabel('After screenshot of page.html')
    const beforeBox = await beforePane.boundingBox()
    const afterBox = await afterPane.boundingBox()
    expect(beforeBox).not.toBeNull()
    expect(afterBox).not.toBeNull()
    expect(Math.abs((beforeBox?.y ?? 0) - (afterBox?.y ?? 0))).toBeLessThan(2)
    expect((beforeBox?.x ?? 0) + (beforeBox?.width ?? 0)).toBeLessThanOrEqual(afterBox?.x ?? 0)

    await mainWindow.evaluate(async () => {
      const anodex = (globalThis as unknown as { anodex: AnodexApi }).anodex
      await anodex.conversations.clearVisualPreviews()
    })
    await mainWindow.reload()
    await waitForStartup(mainWindow)
    await expandTurnActivity(mainWindow)
    await expect(mainWindow.getByRole('button', { name: 'Retry Rendered page.html' })).toBeVisible()
    await expect(
      mainWindow.getByRole('button', { name: 'Re-inspect page.html' }).last()
    ).toBeVisible()
    await expect(mainWindow.getByRole('button', { name: 'Show again result.png' })).toBeVisible()
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
    await waitForStartup(mainWindow)
    const image = mainWindow.getByAltText('robot.png')
    await expect(image).toBeVisible()
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/)

    const openButton = mainWindow.getByRole('button', { name: 'Open robot.png fullscreen' })
    await openButton.scrollIntoViewIfNeeded()
    await openButton.click()
    await expect(
      mainWindow.getByRole('dialog', { name: 'Fullscreen image: robot.png' })
    ).toBeVisible()
    await mainWindow.getByRole('button', { name: 'Close fullscreen image' }).click()
    await expect(openButton).toBeFocused()

    await rm(imagePath)
    await mainWindow.reload()
    await expect(mainWindow.getByText('Image unavailable')).toBeVisible()
    await expect(mainWindow.getByRole('button', { name: 'Retry robot.png' })).toBeVisible()
    await expect(
      mainWindow.getByRole('button', { name: 'Locate file for robot.png' })
    ).toBeVisible()
  } finally {
    await app.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('visual preview storage reports usage and clears stored pixels', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'anodex-preview-storage-e2e-'))
  const assetDir = join(userDataDir, 'conversation-assets', 'storage-test')
  await mkdir(assetDir, { recursive: true })
  await writeFile(join(assetDir, 'message-1-preview.png'), ONE_PIXEL_PNG)

  const app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userDataDir}`]
  })

  try {
    const mainWindow = await app.firstWindow()
    await waitForStartup(mainWindow)
    await mainWindow.getByRole('button', { name: 'Settings', exact: true }).click()
    await mainWindow.getByRole('button', { name: 'Tools', exact: true }).click()

    await expect(mainWindow.getByRole('heading', { name: 'Visual preview storage' })).toBeVisible()
    await expect(mainWindow.getByText(/1 preview across 1 conversation/)).toBeVisible()
    await mainWindow.getByRole('button', { name: 'Clear visual previews' }).click()
    await expect(mainWindow.getByRole('dialog', { name: 'Clear visual previews?' })).toBeVisible()
    await mainWindow.getByRole('button', { name: 'Clear previews' }).click()
    await expect(mainWindow.getByText('No visual previews stored')).toBeVisible()

    const usage = await mainWindow.evaluate(async () => {
      const anodex = (globalThis as unknown as { anodex: AnodexApi }).anodex
      return anodex.conversations.getVisualPreviewUsage()
    })
    expect(usage).toMatchObject({
      ok: true,
      value: { totalBytes: 0, fileCount: 0, conversationCount: 0 }
    })
  } finally {
    await app.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('a running download stays clear of the settings close button', async ({
  browserName: _browserName
}, testInfo) => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'anodex-download-header-e2e-'))
  const app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userDataDir}`]
  })

  try {
    const mainWindow = await app.firstWindow()
    await waitForStartup(mainWindow)
    await mainWindow.getByRole('button', { name: 'Settings', exact: true }).click()

    // Push progress down the real IPC channel rather than poking the store,
    // so this exercises the path a download actually takes.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('models:download-progress', {
        modelId: 'e2e/header-spacing',
        receivedBytes: 3_221_225_472,
        totalBytes: 4_294_967_296,
        status: 'downloading'
      })
    })

    const bar = mainWindow.getByRole('status', { name: /percent downloaded/ })
    await expect(bar).toBeVisible()
    await expect(bar).toHaveAttribute('aria-label', /75 percent downloaded/)

    // The close button is absolutely positioned *over* the header, so the
    // header cannot lay itself out around it. Without the reserved padding
    // the two all but touch.
    const barBox = await bar.boundingBox()
    // The sidebar has its own "Close settings" control, so pin the corner one.
    const closeBox = await mainWindow
      .locator('button[aria-label="Close settings"][title="Close"]')
      .boundingBox()
    expect(barBox).not.toBeNull()
    expect(closeBox).not.toBeNull()
    const gap = (closeBox?.x ?? 0) - ((barBox?.x ?? 0) + (barBox?.width ?? 0))
    expect(gap).toBeGreaterThanOrEqual(8)

    // Let the modal's open transition settle so the attached image is legible.
    await mainWindow.waitForTimeout(400)
    await mainWindow.screenshot({ path: testInfo.outputPath('settings-download-header.png') })
  } finally {
    await app.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})
