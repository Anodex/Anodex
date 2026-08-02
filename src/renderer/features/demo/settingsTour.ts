/**
 * Settings tour — B-roll, not a demo.
 *
 * There's no task being accomplished here, so this is deliberately just a slow
 * walk down a handful of setting pages with long holds, meant to be cut under
 * narration rather than shown end to end. It changes nothing: no toggle is
 * flipped, no field is typed into, so it's safe to run repeatedly against real
 * settings.
 *
 * Dev-only; registered in `index.ts`.
 */
import { clickElement } from './demoCursor'
import { beat, byText, waitFor } from './demoKit'

/** Held on each page. Long, because reading is the only thing happening. */
const PAGE_HOLD_MS = 3200

/**
 * The pages worth showing, in an order that tells a rough story: who you are,
 * how it looks, what it remembers, what it can do, what's driving it.
 */
export const TOUR_PAGES = ['Profile', 'Appearance', 'Memory', 'Tools', 'AI & Models', 'MCP Servers']

/** Opens Settings via the sidebar profile button. */
async function openSettings(): Promise<void> {
  const profile = await waitFor(
    () => document.querySelector<HTMLButtonElement>('button[title="Open settings"]'),
    'the settings button'
  )
  await clickElement(profile)
  await beat(1600)
}

/** Walks the listed pages, holding on each. */
export async function runSettingsTour(): Promise<void> {
  console.log('%c▶ Settings tour (B-roll — nothing is changed)', 'font-weight:bold')

  await openSettings()

  for (const page of TOUR_PAGES) {
    const nav = byText<HTMLButtonElement>('button', page)
    if (!nav) {
      console.warn(`Settings tour: page "${page}" not found, skipping`)
      continue
    }
    await clickElement(nav)
    await beat(PAGE_HOLD_MS)
  }

  const close = byText<HTMLButtonElement>('button', 'Close settings')
  if (close) await clickElement(close)
}
