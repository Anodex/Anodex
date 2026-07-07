import { useMemo } from 'react'
import type { ChartBucket, ModelUsageBreakdown } from '@shared/stats.types'
import { formatCompactNumber, formatDay } from './formatters'
import { colorForModel } from './modelColor'
import styles from './UsageBarChart.module.css'

interface UsageBarChartProps {
  buckets: ChartBucket[]
  models: ModelUsageBreakdown[]
}

/** Fixed pixel height for the axis's max value — segment heights are computed directly in
 *  pixels against this (rather than nested CSS percentages), so a bar's total height is simply
 *  the natural sum of its stacked segments, no ancestor-height resolution to worry about. */
const CHART_HEIGHT_PX = 160

/** Max number of x-axis labels shown regardless of bucket count — dense data just skips labels. */
const MAX_LABELS = 8

/** Number of horizontal gridlines above zero (i.e. 4 → 0/25%/50%/75%/100% labels). */
const AXIS_TICKS = 4

/** Rounds `value` up to a "nice" 1/2/5×10ⁿ number, so axis labels read like 2.0M/4.0M rather
 *  than an arbitrary exact max. Returns 1 for a non-positive input. */
function niceMax(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return niceNormalized * magnitude
}

/** Stacked bar chart of tokens over time, colored by model. Built from flex `<div>`s — no
 *  charting library, no SVG — matching this project's CSS-Modules-first convention. */
export function UsageBarChart({ buckets, models }: UsageBarChartProps): JSX.Element {
  const axisMax = useMemo(() => niceMax(Math.max(0, ...buckets.map((b) => b.total))), [buckets])
  const labelInterval = Math.max(1, Math.ceil(buckets.length / MAX_LABELS))

  if (buckets.length === 0) {
    return <p className={styles.emptyHint}>No activity in this range yet.</p>
  }

  const ticks = Array.from({ length: AXIS_TICKS + 1 }, (_, i) => (axisMax / AXIS_TICKS) * i).reverse()

  return (
    <div className={styles.chartWrap}>
      <div className={styles.yAxis}>
        {ticks.map((tick) => (
          <div key={tick} className={styles.tickLabel}>
            {formatCompactNumber(tick)}
          </div>
        ))}
      </div>
      <div className={styles.scrollArea}>
        <div className={styles.chart}>
          {buckets.map((bucket, index) => {
            const tooltip = models
              .filter((m) => bucket.byModel[m.modelId])
              .map((m) => `${m.modelName}: ${bucket.byModel[m.modelId].toLocaleString()}`)
              .join('\n')
            return (
              <div key={bucket.key} className={styles.column} title={tooltip || undefined}>
                <div className={styles.barArea}>
                  <div className={styles.bar}>
                    {models
                      .filter((m) => bucket.byModel[m.modelId])
                      .map((m) => (
                        <div
                          key={m.modelId}
                          className={styles.segment}
                          style={{
                            height: `${(bucket.byModel[m.modelId] / axisMax) * CHART_HEIGHT_PX}px`,
                            background: colorForModel(m.modelId)
                          }}
                        />
                      ))}
                  </div>
                </div>
                <div className={styles.label}>
                  {index % labelInterval === 0 ? formatDay(bucket.key) : ''}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
