import { create } from 'zustand'
import type { CriticalThinkingRun } from '@shared/criticalThinking.types'
import type { Plan } from '@shared/plan.types'
import { anodex } from '../lib/anodex'
import { notifyError } from './uiStore'

interface CriticalThinkingState {
  runs: CriticalThinkingRun[]
  selectedId: string | null
  loaded: boolean
  load: () => Promise<void>
  create: (question: string) => Promise<CriticalThinkingRun | null>
  approve: (id: string, plan: Plan) => Promise<void>
  resume: (id: string) => Promise<void>
  stop: (id: string) => Promise<void>
  delete: (id: string) => Promise<void>
  select: (id: string | null) => void
  appendToken: (runId: string, token: string) => void
  setRuns: (runs: CriticalThinkingRun[]) => void
}

function upsert(runs: CriticalThinkingRun[], next: CriticalThinkingRun): CriticalThinkingRun[] {
  const found = runs.some((run) => run.id === next.id)
  return found ? runs.map((run) => (run.id === next.id ? next : run)) : [next, ...runs]
}

/** Mirrors persisted Critical Thinking runs while retaining the live streamed report text. */
export const useCriticalThinkingStore = create<CriticalThinkingState>((set) => ({
  runs: [],
  selectedId: null,
  loaded: false,

  load: async () => {
    const runs = await anodex.criticalThinking.list()
    set((state) => ({
      runs,
      loaded: true,
      selectedId:
        state.selectedId && runs.some((run) => run.id === state.selectedId)
          ? state.selectedId
          : (runs[0]?.id ?? null)
    }))
  },

  create: async (question) => {
    try {
      const run = await anodex.criticalThinking.create({ question })
      set((state) => ({ runs: upsert(state.runs, run), selectedId: run.id }))
      return run
    } catch (error) {
      notifyError(
        'Could not start Critical Thinking',
        error instanceof Error ? error.message : undefined
      )
      return null
    }
  },

  approve: async (id, plan) => {
    try {
      const run = await anodex.criticalThinking.approve(id, { plan })
      set((state) => ({ runs: upsert(state.runs, run) }))
    } catch (error) {
      notifyError('Could not start research', error instanceof Error ? error.message : undefined)
    }
  },

  resume: async (id) => {
    try {
      const run = await anodex.criticalThinking.resume(id)
      set((state) => ({ runs: upsert(state.runs, run) }))
    } catch (error) {
      notifyError('Could not resume research', error instanceof Error ? error.message : undefined)
    }
  },

  stop: async (id) => {
    try {
      await anodex.criticalThinking.stop(id)
    } catch (error) {
      notifyError('Could not stop research', error instanceof Error ? error.message : undefined)
    }
  },

  delete: async (id) => {
    try {
      await anodex.criticalThinking.delete(id)
      set((state) => {
        const runs = state.runs.filter((run) => run.id !== id)
        return {
          runs,
          selectedId: state.selectedId === id ? (runs[0]?.id ?? null) : state.selectedId
        }
      })
    } catch (error) {
      notifyError('Could not delete research', error instanceof Error ? error.message : undefined)
    }
  },

  select: (id) => set({ selectedId: id }),

  appendToken: (runId, token) =>
    set((state) => ({
      runs: state.runs.map((run) =>
        run.id === runId ? { ...run, report: run.report + token } : run
      )
    })),

  setRuns: (incoming) =>
    set((state) => {
      // Main persists the report only when generation finishes. Activity
      // broadcasts during a live run therefore carry an empty report; keep
      // the renderer's streamed copy until a terminal snapshot arrives.
      const runs = incoming.map((run) => {
        const current = state.runs.find((item) => item.id === run.id)
        return (run.status === 'synthesizing' || run.status === 'validating') &&
          !run.report &&
          current?.report
          ? { ...run, report: current.report }
          : run
      })
      return {
        runs,
        selectedId:
          state.selectedId && runs.some((run) => run.id === state.selectedId)
            ? state.selectedId
            : (runs[0]?.id ?? null)
      }
    })
}))
