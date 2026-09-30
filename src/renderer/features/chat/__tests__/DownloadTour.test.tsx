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

/**
 * Components rendered inside another, and where: their controls take their
 * place in the parent's order at the point they are mounted.
 */
const MOUNTED_IN: Record<string, { parent: string; marker: string }> = {
  'src/renderer/components/sidebar/SidebarModeSwitcher.tsx': {
    parent: 'src/renderer/components/TitleBar.tsx',
    marker: '<SidebarModeSwitcher'
  },
  'src/renderer/features/chat/composer/ComposerPermissionMenu.tsx': {
    parent: 'src/renderer/features/chat/ChatComposer.tsx',
    marker: '<ComposerPermissionMenu'
  }
}

/** Each toured control's place on screen, as [position in its host file, position within a mounted child]. */
function screenOrder(): Map<string, [string, number, number]> {
  const order = new Map<string, [string, number, number]>()
  for (const { path, source } of CHROME) {
    const mount = MOUNTED_IN[path]
    for (const match of source.matchAll(/data-tour="([^"]+)"/g)) {
      if (mount) {
        const host = CHROME.find((c) => c.path === mount.parent)!.source
        order.set(match[1], [mount.parent, host.indexOf(mount.marker), match.index])
      } else {
        order.set(match[1], [path, match.index, 0])
      }
    }
  }
  return order
}

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

describe('DownloadTour order', () => {
  it('walks the window in reading order: top bar, then rail, then message box', () => {
    const areas = SLIDES.map((s) => s.area).filter((a, i, all) => a !== all[i - 1])
    expect(areas).toEqual(['titleBar', 'rail', 'composer'])
  })

  it('tours each area in the order its controls appear in the app', () => {
    const order = screenOrder()
    for (const area of ['titleBar', 'rail', 'composer'] as const) {
      const toured = SLIDES.filter((s) => s.area === area).map((s) => s.id)
      const onScreen = [...toured].sort((a, b) => {
        const [, aHost, aChild] = order.get(a)!
        const [, bHost, bChild] = order.get(b)!
        return aHost - bHost || aChild - bChild
      })
      expect(toured, `${area} slides should follow the app`).toEqual(onScreen)
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
