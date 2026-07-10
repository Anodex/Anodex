import { create } from 'zustand'
import type { CloudProviderId, ProviderUsageSnapshot } from '@shared/providerUsage.types'

interface ProviderUsageState {
  snapshots: Partial<Record<CloudProviderId, ProviderUsageSnapshot>>
  setSnapshot: (snapshot: ProviderUsageSnapshot) => void
  setAll: (snapshots: Partial<Record<CloudProviderId, ProviderUsageSnapshot>>) => void
}

/** Live cloud-provider usage: rate-limit window (Anthropic only) plus today's token tally (both). */
export const useProviderUsageStore = create<ProviderUsageState>((set) => ({
  snapshots: {},
  setSnapshot: (snapshot) =>
    set((state) => ({ snapshots: { ...state.snapshots, [snapshot.provider]: snapshot } })),
  setAll: (snapshots) => set({ snapshots })
}))
