import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DownloadTour } from '../DownloadTour'
import { SLIDES } from '../downloadTourSlides'

/**
 * The tour exists to name the controls a first-time user is looking at, so a
 * control that gains a place in the chrome without a slide is the regression
 * worth catching, and so is a slide whose picture is not the control's own icon.
 */
describe('DownloadTour', () => {
  it('covers the navigation rail, the top bar, the composer, and the profile button', () => {
    expect(SLIDES.map((s) => s.icon)).toEqual([
      'chat',
      'code',
      'panel-left',
      'search',
      'clock',
      'bot',
      'insight',
      'mail',
      'paperclip',
      'shield-check',
      'settings',
      'user'
    ])
  })

  it('opens on the first slide with a dot for every slide', () => {
    const html = renderToStaticMarkup(<DownloadTour />)
    expect(html).toContain(`1 of ${SLIDES.length}`)
    expect(html).toContain(SLIDES[0].title)
    for (const slide of SLIDES) expect(html).toContain(`aria-label="${slide.title}"`)
  })
})
