import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReleaseNotesContent } from './ReleaseNotesContent'

describe('release note rendering', () => {
  it('formats notes while keeping GitHub text inert', () => {
    const html = renderToStaticMarkup(
      <ReleaseNotesContent
        body={
          '## New\n- **Faster** browsing\n- [Unsafe](javascript:alert(1))\n- <script>alert(1)</script>'
        }
      />
    )

    expect(html).toContain('<h3>New</h3>')
    expect(html).toContain('<strong>Faster</strong>')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
