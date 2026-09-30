import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DownloadTour } from '../DownloadTour'
import { SLIDES } from '../downloadTourSlides'

vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: (select: (s: { settings: null }) => unknown) => select({ settings: null })
}))

/**
 * The components whose controls the tour names. A control that is toured
 * carries `data-tour="<slide id>"` on the real element.
 */
const CHROME = [
  'src/renderer/components/TitleBar.tsx',
  'src/renderer/components/sidebar/SidebarModeSwitcher.tsx',
  'src/renderer/components/sidebar/SidebarRail.tsx',
  'src/renderer/features/chat/ChatComposer.tsx',
  'src/renderer/features/chat/composer/ComposerPermissionMenu.tsx'
].map((path) => ({ path, source: readFileSync(join(process.cwd(), path), 'utf-8') }))

function taggedControls(): Map<string, string> {
  const tags = new Map<string, string>()
  for (const { path, source } of CHROME) {
    for (const match of source.matchAll(/data-tour="([^"]+)"/g)) tags.set(match[1], path)
  }
  return tags
}

/**
 * The tour draws each control from a list of its own, which cannot follow the
 * app when a button is added, removed, or given a new icon. These tests fail
 * instead, naming the control, so the tour is updated in the same change.
 */
describe('DownloadTour drift', () => {
  it('has a slide for every toured control, and a control for every slide', () => {
    const tags = taggedControls()
    expect([...tags.keys()].sort()).toEqual(SLIDES.map((s) => s.id).sort())
  })

  it('draws each control with the icon the control itself uses', () => {
    const tags = taggedControls()
    for (const slide of SLIDES) {
      const source = CHROME.find((c) => c.path === tags.get(slide.id))?.source ?? ''
      expect(source, `${slide.id} should use the "${slide.icon}" icon`).toMatch(
        new RegExp(`['"]${slide.icon}['"]`)
      )
    }
  })
})

describe('DownloadTour', () => {
  it('opens on the first slide with a segment for every slide', () => {
    const html = renderToStaticMarkup(<DownloadTour />)
    expect(html).toContain(`1 of ${SLIDES.length}`)
    expect(html).toContain(SLIDES[0].title)
    for (const slide of SLIDES) expect(html).toContain(`aria-label="${slide.title}"`)
  })

  it('shows the default shortcut when the user has not set one', () => {
    const html = renderToStaticMarkup(<DownloadTour />)
    expect(html).toContain('<kbd')
    expect(html).toContain('>N<')
  })
})
