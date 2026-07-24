import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ExpandableImage } from '../ExpandableImage'

describe('ExpandableImage', () => {
  it('renders an accessible fullscreen trigger around the image', () => {
    const html = renderToStaticMarkup(
      <ExpandableImage src="data:image/png;base64,cGl4ZWxz" alt="Robot drawing" title="robot.png" />
    )

    expect(html).toContain('aria-label="Open robot.png fullscreen"')
    expect(html).toContain('alt="Robot drawing"')
    expect(html).toContain('data:image/png;base64,cGl4ZWxz')
  })
})
