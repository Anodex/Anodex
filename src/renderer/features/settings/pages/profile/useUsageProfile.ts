import { useCallback, useEffect, useState } from 'react'
import type { UsageProfile } from '@shared/stats.types'
import { anodex } from '../../../../lib/anodex'

interface UseUsageProfileResult {
  profile: UsageProfile | null
  loading: boolean
  refresh: () => void
}

/**
 * Fetches the all-time token-activity usage profile. Local component state
 * rather than a Zustand store — nothing else in the app needs this data, and
 * it only ever needs a single fetch per Profile page visit.
 */
export function useUsageProfile(): UseUsageProfileResult {
  const [profile, setProfile] = useState<UsageProfile | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    void anodex.stats.getUsageProfile().then((result) => {
      if (result.ok) setProfile(result.value)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return { profile, loading, refresh: load }
}
