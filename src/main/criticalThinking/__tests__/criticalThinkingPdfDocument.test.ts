import { describe, expect, it } from 'vitest'
import {
  buildCriticalThinkingPdfDocument,
  criticalThinkingPdfFilename
} from '../criticalThinkingPdfDocument'

describe('Critical Thinking PDF document', () => {
  it('creates a stable, filesystem-safe PDF filename', () => {
    expect(criticalThinkingPdfFilename('Should we hire in Montréal / Denver?')).toBe(
      'should-we-hire-in-montreal-denver.pdf'
    )
    expect(criticalThinkingPdfFilename('???')).toBe('critical-thinking-report.pdf')
  })

  it('escapes the question and preserves the already-rendered report markup', () => {
    const html = buildCriticalThinkingPdfDocument({
      question: '<Buy & build?>',
      reportHtml: '<article data-critical-thinking-report><h1>Decision</h1></article>'
    })

    expect(html).toContain('&lt;Buy &amp; build?&gt;')
    expect(html).not.toContain('<Buy & build?>')
    expect(html).toContain('<article data-critical-thinking-report>')
    expect(html).toContain("default-src 'none'")
    expect(html).not.toContain('<script')
  })
})
