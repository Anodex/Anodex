import { create } from 'zustand'
import type { AgentRun, CreateAgentRunRequest } from '@shared/agentRun.types'
import { anodex } from '../lib/anodex'
import { notifyError } from './uiStore'

interface AgentState {
  runs: AgentRun[]
  loaded: boolean
  load: () => Promise<void>
  create: (request: CreateAgentRunRequest) => Promise<AgentRun | null>
  stop: (id: string) => Promise<void>
  delete: (id: string) => Promise<void>
  /** Called by the IPC bridge when the main process broadcasts a run list change. */
  setRuns: (runs: AgentRun[]) => void
}

/** Mirrors the persisted agent-run list from the main process. */
export const useAgentStore = create<AgentState>((set) => ({
  runs: [],
  loaded: false,

  load: async () => {
    const runs = await anodex.agent.list()
    set({ runs, loaded: true })
  },

  create: async (request) => {
    try {
      const run = await anodex.agent.create(request)
      set((state) => ({ runs: [run, ...state.runs] }))
      return run
    } catch (error) {
      notifyError('Could not start agent run', error instanceof Error ? error.message : undefined)
      return null
    }
  },

  stop: async (id) => {
    try {
      await anodex.agent.stop(id)
    } catch (error) {
      notifyError('Could not stop agent run', error instanceof Error ? error.message : undefined)
    }
  },

  delete: async (id) => {
    try {
      await anodex.agent.delete(id)
      set((state) => ({ runs: state.runs.filter((r) => r.id !== id) }))
    } catch (error) {
      notifyError('Could not delete agent run', error instanceof Error ? error.message : undefined)
    }
  },

  setRuns: (runs) => set({ runs })
}))
