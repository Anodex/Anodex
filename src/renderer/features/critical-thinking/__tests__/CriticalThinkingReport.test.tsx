import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CriticalThinkingReport } from '../CriticalThinkingReport'

describe('CriticalThinkingReport', () => {
  it('renders a valid cited chart block as accessible SVG', () => {
    const report = `# Findings

\`\`\`chart
{"type":"pie","title":"Market share","labels":["Alpha","Beta"],"datasets":[{"label":"Share","values":[60,40]}],"unit":"%","source":"[Dataset](https://example.com/data)"}
\`\`\``
    const html = renderToStaticMarkup(<CriticalThinkingReport report={report} />)

    expect(html).toContain('data-critical-thinking-report="true"')
    expect(html).toContain('data-critical-thinking-chart="true"')
    expect(html).toContain('<svg')
    expect(html).toContain('aria-label="Market share"')
    expect(html).toContain('href="https://example.com/data"')
  })

  it('falls back to a code block when chart data is invalid', () => {
    const html = renderToStaticMarkup(
      <CriticalThinkingReport report={'```chart\n{"type":"pie"}\n```'} />
    )

    expect(html).not.toContain('data-critical-thinking-chart')
    expect(html).toContain('<pre')
  })
})
