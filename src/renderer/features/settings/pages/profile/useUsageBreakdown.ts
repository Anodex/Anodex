import { useEffect, useState } from 'react'
import type { ChartGranularity, ChartRange, UsageBreakdown } from '@shared/stats.types'
import { anodex } from '../../../../lib/anodex'

interface UseUsageBreakdownResult {
  breakdown: UsageBreakdown | null
  loading: boolean
}

/**
 * Fetches the per-model token breakdown + chart series for a given time
 * range/granularity, re-fetching whenever either changes. Kept as a separate
 * call from `useUsageProfile` so switching the range/granularity toggle
 * doesn't re-fetch the (potentially large) all-time daily-activity data the
 * heatmap/streaks use.
 */
export function useUsageBreakdown(
  range: ChartRange,
  granularity: ChartGranularity
): UseUsageBreakdownResult {
  const [breakdown, setBreakdown] = useState<UsageBreakdown | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void anodex.stats.getUsageBreakdown(range, granularity).then((result) => {
      if (cancelled) return
      if (result.ok) setBreakdown(result.value)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [range, granularity])

  return { breakdown, loading }
}
