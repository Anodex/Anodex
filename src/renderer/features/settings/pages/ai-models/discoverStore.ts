import { create } from 'zustand'
import type { RecommendedModel } from '@shared/recommendedModels'

/**
 * What the Discover panel last searched for, and what came back.
 *
 * This lived in the panel's own `useState`, which meant a Hugging Face search
 * existed only for as long as the AI Models page stayed mounted. Move to
 * another settings section and back and the results were gone — including the
 * card for a model that was still downloading, which is how a running download
 * came to look like a stopped one.
 *
 * Kept deliberately small and deliberately not persisted to disk: a search is
 * worth surviving a click across the settings nav, not a restart.
 */
interface DiscoverState {
  query: string
  /** `null` before the first search; `[]` when a search genuinely found nothing. */
  results: RecommendedModel[] | null
  error: string | null
  setQuery: (query: string) => void
  setOutcome: (results: RecommendedModel[], error: string | null) => void
}

export const useDiscoverStore = create<DiscoverState>((set) => ({
  query: '',
  results: null,
  error: null,
  setQuery: (query) => set({ query }),
  setOutcome: (results, error) => set({ results, error })
}))
