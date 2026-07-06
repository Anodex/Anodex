import { useMemo } from 'react'
import type { ChartBucket, ModelUsageBreakdown } from '@shared/stats.types'
import { formatDay } from './formatters'
import { colorForModel } from './modelColor'
import styles from './UsageBarChart.module.css'

interface UsageBarChartProps {
  buckets: ChartBucket[]
  models: ModelUsageBreakdown[]
}

/** Fixed pixel height for the tallest possible bar — segment heights are computed directly in
 *  pixels against this (rather than nested CSS percentages), so a bar's total height is simply
 *  the natural sum of its stacked segments, no ancestor-height resolution to worry about. */
const CHART_HEIGHT_PX = 160

/** Max number of x-axis labels shown regardless of bucket count — dense data just skips labels. */
const MAX_LABELS = 8

/** Stacked bar chart of tokens over time, colored by model. Built from flex `<div>`s — no
 *  charting library, no SVG — matching this project's CSS-Modules-first convention. */
export function UsageBarChart({ buckets, models }: UsageBarChartProps): JSX.Element {
  const maxTotal = useMemo(() => Math.max(1, ...buckets.map((b) => b.total)), [buckets])
  const labelInterval = Math.max(1, Math.ceil(buckets.length / MAX_LABELS))

  if (buckets.length === 0) {
    return <p className={styles.emptyHint}>No activity in this range yet.</p>
  }

  return (
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
                        height: `${(bucket.byModel[m.modelId] / maxTotal) * CHART_HEIGHT_PX}px`,
                        background: colorForModel(m.modelId)
                      }}
                    />
                  ))}
              </div>
            </div>
            <div className={styles.label}>{index % labelInterval === 0 ? formatDay(bucket.key) : ''}</div>
          </div>
        )
      })}
    </div>
  )
}
