import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { AnodexApi } from '../src/shared/ipc'
import type { Conversation } from '../src/shared/conversation.types'
import { expectNoCrash, launchFresh } from './helpers'

/**
 * The journeys a person takes through the real app, on a fresh profile each.
 *
 * Unit tests cover the pieces; these cover the joins between them that only
 * exist in a built app: the preload bridge, a screen's code being read the
 * first time it opens, a save surviving a quit, a setup dialog reaching the
 * main process and back. No model is needed for any of them, so they run on a
 * CI runner without a GPU or a download.
 */

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  const now = Date.now()
  return {
    id: 'journey-chat',
    projectId: null,
    title: 'Plan the garden',
    createdAt: now - 60_000,
    updatedAt: now,
    archived: false,
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: 'Which vegetables grow in shade?',
        createdAt: now - 60_000
      },
      {
        id: 'u1:reply',
        role: 'assistant',
        content: 'Lettuce, spinach and kale all manage with a few hours of sun.',
        createdAt: now - 50_000
      }
    ],
    ...overrides
  }
}

async function save(window: Page, value: Conversation): Promise<void> {
  await window.evaluate(async (c) => {
    const anodex = (globalThis as unknown as { anodex: AnodexApi }).anodex
    await anodex.conversations.save(c)
  }, value)
}

test('every main screen opens without crashing', async () => {
  const run = await launchFresh()
  try {
    const { window } = run
    for (const [rail, heading] of [
      ['Scheduler', /Schedul/],
      ['Agent', /Agent/],
      ['Critical Thinking', /Critical Thinking/],
      ['Email', /Email/],
      ['Chat', /Chat/]
    ] as const) {
      await window.getByRole('button', { name: rail, exact: true }).click()
      await expect(window.getByRole('heading', { name: heading }).first()).toBeVisible()
      await expectNoCrash(window)
    }
    expect(run.pageErrors).toEqual([])
  } finally {
    await run.dispose()
  }
})

test('every Settings page opens without crashing', async () => {
  const run = await launchFresh()
  try {
    const { window } = run
    await window.getByRole('button', { name: 'Profile and settings' }).click()
    const settings = window.getByRole('dialog', { name: 'Settings' })
    await expect(settings).toBeVisible()
    for (const page of [
      'Profile',
      'Appearance',
      'Keyboard',
      'Memory',
      'Voice',
      'Skills',
      'Autonomy',
      'Tools',
      'AI & Models',
      'Email',
      'GitHub',
      'MCP Servers',
      'Remote',
      'Archive',
      'Diagnostics',
      'About'
    ]) {
      await settings.getByRole('button', { name: page, exact: true }).click()
      await expect(settings.getByRole('heading', { level: 1 }).first()).toBeVisible()
      await expectNoCrash(window)
    }
    expect(run.pageErrors).toEqual([])
  } finally {
    await run.dispose()
  }
})

test('a chat saved just before quitting is there after a restart', async () => {
  const first = await launchFresh()
  try {
    // A burst of saves and an immediate quit. Saves are written off the main
    // thread, so this checks the outcome a person relies on: the newest one is
    // on disk next launch. (A normal quit gives queued writes time to land, so
    // the synchronous flush itself is pinned by the store's unit tests.)
    await first.window.evaluate(async (base) => {
      const anodex = (globalThis as unknown as { anodex: AnodexApi }).anodex
      await anodex.conversations.save(base)
      for (let n = 1; n <= 10; n++) {
        void anodex.conversations.save({
          ...base,
          title: `Garden plan ${n}`,
          updatedAt: base.updatedAt + n
        })
      }
    }, conversation())
    await first.quit()

    const second = await launchFresh(first.userDataDir)
    try {
      await second.window.getByText('Garden plan 10').first().click()
      await expect(second.window.getByText('Lettuce, spinach and kale')).toBeVisible()
      await expectNoCrash(second.window)
    } finally {
      await second.quit()
    }
  } finally {
    await first.dispose()
  }
})

test('a chat can be archived and restored', async () => {
  const run = await launchFresh()
  try {
    const { window } = run
    await save(window, conversation())
    await window.reload()
    await expect(window.getByText('Plan the garden').first()).toBeVisible({ timeout: 30_000 })

    const row = window.getByText('Plan the garden').first()
    await row.hover()
    await window.getByRole('button', { name: 'Archive chat' }).first().click()
    await expect(window.getByText('Plan the garden')).toHaveCount(0)

    await window.getByRole('button', { name: 'Profile and settings' }).click()
    const settings = window.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Archive', exact: true }).click()
    await settings.getByRole('button', { name: 'Restore' }).first().click()
    await settings.getByRole('button', { name: 'Close settings' }).first().click()

    await expect(window.getByText('Plan the garden').first()).toBeVisible()
    expect(run.pageErrors).toEqual([])
  } finally {
    await run.dispose()
  }
})

test('web search setup tests before saving, and saves nothing that failed', async () => {
  const run = await launchFresh()
  try {
    const { window } = run
    await window.getByRole('button', { name: 'Critical Thinking', exact: true }).click()
    await window.getByRole('button', { name: 'Set up web search' }).click()

    const dialog = window.getByRole('dialog', { name: 'Set up web search' })
    await expect(dialog.getByRole('radio', { name: /Tavily/ })).toBeChecked()
    await dialog.getByRole('radio', { name: /SearXNG/ }).click()
    // A port nothing listens on: a real request, a real failure, no outside service.
    await dialog.getByLabel(/Its address/).fill('http://127.0.0.1:9')
    await dialog.getByRole('button', { name: 'Test and save' }).click()

    await expect(dialog.getByRole('alert')).toContainText('Nothing answered at http://127.0.0.1:9')
    const provider = await window.evaluate(async () => {
      const anodex = (globalThis as unknown as { anodex: AnodexApi }).anodex
      return (await anodex.settings.get()).webSearch.provider
    })
    expect(provider).toBe('none')
  } finally {
    await run.dispose()
  }
})
