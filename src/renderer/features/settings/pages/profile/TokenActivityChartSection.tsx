import { useState } from 'react'
import type { ChartGranularity, ChartRange } from '@shared/stats.types'
import { Spinner } from '../../../../components/ui/Spinner'
import { ModelBreakdownList } from './ModelBreakdownList'
import { SegmentedToggle } from './SegmentedToggle'
import { UsageBarChart } from './UsageBarChart'
import { useUsageBreakdown } from './useUsageBreakdown'
import styles from './TokenActivityChartSection.module.css'

const RANGE_OPTIONS: { label: string; value: ChartRange }[] = [
  { label: 'All', value: 'all' },
  { label: '30d', value: '30d' },
  { label: '7d', value: '7d' }
]

const GRANULARITY_OPTIONS: { label: string; value: ChartGranularity }[] = [
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Cumulative', value: 'cumulative' }
]

/** Tokens-over-time chart + per-model breakdown, with its own range/granularity controls. */
export function TokenActivityChartSection(): JSX.Element {
  const [range, setRange] = useState<ChartRange>('all')
  const [granularity, setGranularity] = useState<ChartGranularity>('daily')
  const { breakdown, loading } = useUsageBreakdown(range, granularity)

  return (
    <div className={styles.panel}>
      <div className={styles.headerRow}>
        <h3 className={styles.panelTitle}>Tokens over time</h3>
        <div className={styles.toggles}>
          <SegmentedToggle value={range} options={RANGE_OPTIONS} onChange={setRange} />
          <SegmentedToggle value={granularity} options={GRANULARITY_OPTIONS} onChange={setGranularity} />
        </div>
      </div>

      {loading && !breakdown ? (
        <div className={styles.loading}>
          <Spinner size={18} />
        </div>
      ) : breakdown ? (
        <>
          <UsageBarChart buckets={breakdown.chart} models={breakdown.models} />
          <ModelBreakdownList models={breakdown.models} />
        </>
      ) : (
        <p className={styles.emptyHint}>Could not load usage data.</p>
      )}
    </div>
  )
}
