import { describe, expect, it } from 'vitest'
import {
  appendCriticalThinkingCharts,
  parseCriticalThinkingChartSelection,
  reportHasEvidenceChart,
  reportHasQuantitativeProse
} from '../criticalThinkingCharts'

describe('Critical Thinking chart recovery', () => {
  it('accepts an explicit empty selection when a chart would not help', () => {
    expect(parseCriticalThinkingChartSelection('{"charts":[]}')).toEqual([])
    expect(parseCriticalThinkingChartSelection('not json')).toBeNull()
  })

  it('serializes selected charts and inserts them before report limits', () => {
    const blocks = parseCriticalThinkingChartSelection(
      JSON.stringify({
        charts: [
          {
            type: 'bar',
            title: 'Venom amount',
            labels: ['Bee', 'Wasp'],
            datasets: [{ label: 'Amount', values: [59, 10] }],
            unit: 'μg',
            source: '[[S1:P1]]'
          }
        ]
      })
    )
    const report = `# Report

## Findings

The amounts were 59 and 10 micrograms [[S1:P1]].

## Limits and Open Questions

None recorded.

## Conclusion

The comparison is retained [[S1:P1]].`
    const augmented = appendCriticalThinkingCharts(report, blocks ?? [])

    expect(blocks).toHaveLength(1)
    expect(augmented.indexOf('## Evidence Charts')).toBeLessThan(
      augmented.indexOf('## Limits and Open Questions')
    )
    expect(reportHasEvidenceChart(augmented)).toBe(true)
    expect(reportHasQuantitativeProse(report)).toBe(true)
  })

  it('adds a chart-only citation to an existing Sources section', () => {
    const chart = `\`\`\`chart
{"type":"bar","title":"Result","labels":["A","B"],"datasets":[{"label":"Value","values":[1,2]}],"source":"[[S2:P1]]"}
\`\`\``
    const report = `# Report

## Sources

[[S1]]

## Conclusion

Supported conclusion [[S1:P1]].`

    expect(appendCriticalThinkingCharts(report, [chart])).toMatch(
      /## Sources\s+\[\[S1\]\] \[\[S2\]\]/
    )
  })

  it('does not treat heading or citation identifiers as quantitative prose', () => {
    expect(reportHasQuantitativeProse('# 2. Findings\n\nSupported comparison [[S12:P3]].')).toBe(
      false
    )
  })
})
