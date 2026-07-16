import { describe, expect, it } from 'vitest'
import { parseCriticalThinkingChart } from '../criticalThinkingCharts'

describe('Critical Thinking chart grammar', () => {
  it('accepts a cited quantitative chart', () => {
    const chart = parseCriticalThinkingChart(
      JSON.stringify({
        type: 'bar',
        title: 'Retention by schedule',
        labels: ['Five-day', 'Four-day'],
        datasets: [{ label: 'Retention', values: [81, 89] }],
        unit: '%',
        source: '[Workforce study](https://example.com/study)'
      })
    )

    expect(chart).toMatchObject({ type: 'bar', labels: ['Five-day', 'Four-day'], unit: '%' })
  })

  it('rejects malformed, uncited, and invalid pie charts', () => {
    expect(parseCriticalThinkingChart('{not json')).toBeNull()
    expect(
      parseCriticalThinkingChart(
        JSON.stringify({
          type: 'line',
          title: 'Uncited',
          labels: ['A', 'B'],
          datasets: [{ label: 'Series', values: [1, 2] }],
          source: 'Trust me'
        })
      )
    ).toBeNull()
    expect(
      parseCriticalThinkingChart(
        JSON.stringify({
          type: 'pie',
          title: 'Negative pie',
          labels: ['A', 'B'],
          datasets: [{ label: 'Share', values: [2, -1] }],
          source: '[Data](https://example.com/data)'
        })
      )
    ).toBeNull()
  })
})
