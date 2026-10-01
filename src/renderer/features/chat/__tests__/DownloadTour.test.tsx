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
  'src/renderer/features/workspace-dock/WorkspaceDockButton.tsx',
  'src/renderer/components/sidebar/ModelStatusMenu.tsx',
  'src/renderer/features/chat/ChatComposer.tsx',
  'src/renderer/features/chat/composer/ComposerPermissionMenu.tsx',
  'src/renderer/features/chat/ContextMeter.tsx'
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
  'src/renderer/features/workspace-dock/WorkspaceDockButton.tsx': {
    parent: 'src/renderer/components/TitleBar.tsx',
    marker: '<WorkspaceDockButton'
  },
  'src/renderer/features/chat/composer/ComposerPermissionMenu.tsx': {
    parent: 'src/renderer/features/chat/ChatComposer.tsx',
    marker: '<ComposerPermissionMenu'
  },
  'src/renderer/features/chat/ContextMeter.tsx': {
    parent: 'src/renderer/features/chat/ChatComposer.tsx',
    marker: '<ContextMeter'
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

/** A file's source plus the sibling modules it imports, where an icon choice may live. */
function withLocalImports(path: string): string {
  const source = readFileSync(join(process.cwd(), path), 'utf-8')
  const dir = path.slice(0, path.lastIndexOf('/'))
  const imported = [...source.matchAll(/from '\.\/([\w-]+)'/g)].map((m) => {
    for (const ext of ['.ts', '.tsx']) {
      try {
        return readFileSync(join(process.cwd(), dir, m[1] + ext), 'utf-8')
      } catch {
        // not this extension
      }
    }
    return ''
  })
  return [source, ...imported].join('\n')
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
      if (!slide.icon) continue
      const source = withLocalImports(tags.get(slide.id)!)
      expect(source, `${slide.id} should use the "${slide.icon}" icon`).toMatch(
        new RegExp(`['"]${slide.icon}['"]`)
      )
    }
  })
})

describe('DownloadTour order', () => {
  it('walks the window in reading order: top bar, rail, sidebar foot, message box', () => {
    const areas = SLIDES.map((s) => s.area).filter((a, i, all) => a !== all[i - 1])
    expect(areas).toEqual(['titleBar', 'rail', 'sidebar', 'composer'])
  })

  it('tours each area in the order its controls appear in the app', () => {
    const order = screenOrder()
    for (const area of ['titleBar', 'rail', 'sidebar', 'composer'] as const) {
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

  // Every slide is in the page so the box keeps the tallest one's height;
  // only the current one may be visible or reachable by a screen reader.
  it('lays every slide out but shows only the current one', () => {
    const html = renderToStaticMarkup(<DownloadTour />)
    const slides = [...html.matchAll(/aria-roledescription="slide"[^>]*>/g)].map((m) => m[0])
    expect(slides).toHaveLength(SLIDES.length)
    const shown = slides.filter((tag) => !tag.includes('aria-hidden="true"'))
    expect(shown).toHaveLength(1)
    expect(shown[0]).toContain(`aria-label="1 of ${SLIDES.length}"`)
  })

  it('lists every dock panel from the dock itself', () => {
    const dock = SLIDES.findIndex((s) => s.id === 'dock')
    expect(dock).toBeGreaterThan(-1)
    expect(SLIDES[dock].visual).toBe('dockPanels')
  })

  it('shows the default shortcut when the user has not set one', () => {
    const html = renderToStaticMarkup(<DownloadTour />)
    expect(html).toContain('<kbd')
    expect(html).toContain('>N<')
  })
})
