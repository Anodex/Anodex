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

/**
 * The renderer globals the navigation test reaches for.
 *
 * Declared rather than taken from the DOM lib: this project's e2e config has
 * no DOM types, so `document` and `window` resolve to `any` and every
 * property access on them fails `no-unsafe-member-access`.
 */
interface PageGlobals {
  location: { href: string }
  open: (url: string, target: string) => unknown
  document: {
    readyState: string
    title: string
    body: { innerText: string }
    getElementById: (id: string) => { childElementCount: number } | null
    querySelectorAll: (selector: string) => ArrayLike<{
      getAttribute: (name: string) => string | null
      textContent: string | null
      click: () => void
    }>
  }
}

/**
 * The app shell is not a browser tab.
 *
 * Every other window in Anodex refused outside navigation; the main one did
 * not, and it is the window that shows content Anodex did not write — search
 * results in a reply, and any link a model puts in its output. A plain link
 * replaced the whole application with a remote page, in a frameless window
 * with no back button.
 *
 * Note the DOM is queried directly at the end rather than through a locator.
 * A cancelled navigation stays "pending" as far as Playwright is concerned,
 * so its auto-waiting locators block on a page that is perfectly healthy.
 */
test('the app shell cannot be navigated away', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anodex-nav-'))
  const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${dir}`] })

  try {
    const w = await app.firstWindow()
    await waitForStartup(w)
    const before = w.url()

    // Count what reaches the OS, so "blocked" cannot secretly mean "opened
    // in a browser instead".
    await app.evaluate(({ shell }) => {
      const seen: string[] = []
      ;(globalThis as unknown as { __opened: string[] }).__opened = seen
      shell.openExternal = (url: string): Promise<void> => {
        seen.push(url)
        return Promise.resolve()
      }
    })

    // A plain in-window navigation — the thing that used to replace the app.
    await w.evaluate(() => {
      ;(globalThis as unknown as PageGlobals).location.href = 'https://example.com/'
    })
    await w.waitForTimeout(3000)
    expect(w.url()).toBe(before)

    // A dangerous scheme must not reach the operating system at all.
    await w.evaluate(() => {
      const g = globalThis as unknown as PageGlobals
      g.open('file:///C:/Windows/System32/calc.exe', '_blank')
      g.open('ms-msdt:/id PCWDiagnostic', '_blank')
      g.open('https://example.com/ok', '_blank')
    })
    await w.waitForTimeout(2000)

    const opened = await app.evaluate(
      () => (globalThis as unknown as { __opened: string[] }).__opened
    )
    expect(opened).toEqual(['https://example.com/', 'https://example.com/ok'])
    expect(w.url()).toBe(before)

    // Queried directly rather than through an auto-waiting locator: a
    // cancelled navigation stays "pending" as far as Playwright is
    // concerned, so its locators block on a page that is perfectly healthy.
    const health = await w.evaluate(() => {
      const d = (globalThis as unknown as PageGlobals).document
      return {
        readyState: d.readyState,
        hasRoot: Boolean(d.getElementById('root')?.childElementCount),
        title: d.title
      }
    })
    expect(health).toMatchObject({ readyState: 'complete', hasRoot: true, title: 'Anodex' })

    // And it still responds to a real interaction afterwards.
    const clicked = await w.evaluate(() => {
      const d = (globalThis as unknown as PageGlobals).document
      const button = Array.from(d.querySelectorAll('button')).find(
        (candidate) =>
          candidate.getAttribute('aria-label') === 'Settings' ||
          candidate.textContent?.trim() === 'Settings'
      )
      if (!button) return false
      button.click()
      return true
    })
    expect(clicked).toBe(true)
    await w.waitForTimeout(1500)
    const settingsOpened = await w.evaluate(() =>
      (globalThis as unknown as PageGlobals).document.body.innerText.includes('AI & Models')
    )
    expect(settingsOpened).toBe(true)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * The sub-agent settings, which decide whether delegation does anything.
 *
 * Worth an end-to-end check rather than a unit test because the section's
 * whole job is to state the *consequence* of a configuration, and that
 * depends on settings it does not own — the engine's parallel-job count and
 * where the sub-agents run. A user who enables this on a default single-slot
 * machine gets no sub-agents at all, and the one thing the section must never
 * do is stay quiet about that.
 */
test('sub-agent settings explain why a default local machine gets none', async () => {
  // Its own profile, because this test changes a setting. Run against the
  // real one it both depends on and leaves behind state: the first run
  // enabled sub-agents, and the second then failed looking for the text
  // shown when they are off.
  const userDataDir = await mkdtemp(join(tmpdir(), 'anodex-subagents-e2e-'))
  const app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userDataDir}`]
  })

  try {
    const window = await app.firstWindow()
    await waitForStartup(window)
    await window.getByRole('button', { name: 'Settings', exact: true }).click()
    await window.getByRole('button', { name: 'Tools' }).click()

    await expect(window.getByRole('heading', { name: 'Sub-agents', exact: true })).toBeVisible()

    const toggle = window.getByLabel('Let an agent run delegate work to sub-agents')
    await expect(toggle).toBeVisible()

    // Off by default: a goal that quietly became four runs is not what
    // someone pressing Start agreed to.
    await expect(
      window.getByText('Off. Every run does all of its own work in one sequence.')
    ).toBeVisible()

    await toggle.click()

    // On a single-slot machine with no cloud children configured the answer
    // is "none", and it has to say so rather than appearing to work.
    await expect(window.getByText(/cannot start any/)).toBeVisible()
    await expect(window.getByText(/Parallel jobs/)).toBeVisible()

    // The per-agent provider rows only exist once it is on.
    await expect(window.getByText('Sub-agent 1', { exact: true })).toBeVisible()
  } finally {
    await app.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})

/**
 * Sub-agents as the run list draws them.
 *
 * The only part of this feature a test could not reach until now: the marks,
 * the names and the nesting exist purely in the renderer, and every test of
 * them so far has constructed the components directly. This seeds the run
 * store on disk instead and lets the real app read it, which is the one way
 * to find out whether a delegated run actually looks like anything.
 */
test('a delegated run shows its sub-agents nested underneath it', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'anodex-subagent-list-e2e-'))
  const now = Date.now()
  const base = {
    projectId: null,
    enabledTools: ['read_file'],
    provider: 'local' as const,
    model: null,
    maxTurns: 8,
    turnsUsed: 2,
    flaggedTurns: 0,
    maxTokens: 50_000,
    tokensUsed: 1200,
    maxDurationMinutes: 30,
    activeMs: 60_000,
    activeSinceAt: null,
    limitsEnabled: true,
    conversationId: null,
    summary: 'Done.',
    lastError: null,
    requirePlan: false,
    plan: null,
    createdAt: now,
    updatedAt: now
  }
  // Newest first, the order the store keeps.
  const runs = [
    {
      ...base,
      id: 'child-b',
      parentRunId: 'parent-run',
      delegatedTask: 'check unicode handling',
      goal: 'check unicode handling',
      status: 'done'
    },
    {
      ...base,
      id: 'child-a',
      parentRunId: 'parent-run',
      delegatedTask: 'check the tokenizer',
      goal: 'check the tokenizer',
      status: 'done'
    },
    { ...base, id: 'parent-run', goal: 'Find the bugs in the parser', status: 'done' }
  ]
  await mkdir(join(userDataDir, 'agent-runs'), { recursive: true })
  await writeFile(join(userDataDir, 'agent-runs', 'runs.json'), JSON.stringify(runs), 'utf-8')

  const app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userDataDir}`]
  })

  try {
    const window = await app.firstWindow()
    await waitForStartup(window)
    await window.getByRole('button', { name: 'Agent', exact: true }).click()

    await expect(window.getByText('Find the bugs in the parser')).toBeVisible()

    // Named after the work rather than by position — see `subAgentNames`.
    await expect(window.getByText('Tokenizer', { exact: true })).toBeVisible()
    await expect(window.getByText('Unicode handling', { exact: true })).toBeVisible()

    // The parent says how many it sent out, so a fan-out is legible without
    // opening anything.
    await expect(window.getByText(/2 sub-agents/)).toBeVisible()
  } finally {
    await app.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})
