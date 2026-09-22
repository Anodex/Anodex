import { describe, expect, it, vi } from 'vitest'
import type { AgentRun } from '@shared/agentRun.types'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const journals = new Map<string, string>()
const runs = new Map<string, Partial<AgentRun>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    }
  }
}))

vi.mock('@main/agents/AgentRunService', () => ({
  agentRunService: { start: vi.fn(), stop: vi.fn() }
}))

vi.mock('@main/agents/AgentRunStore', () => ({
  agentRunStore: { list: () => [], get: (id: string) => runs.get(id), delete: vi.fn() }
}))

vi.mock('@main/agents/agentJournal', () => ({
  readJournal: (seriesId: string) => journals.get(seriesId) ?? null
}))

const { registerAgentHandlers } = await import('../agent.handlers')

/**
 * The journal is the agent's memory and it lives in a Markdown file so a person
 * can read it. That argument only holds if the app actually shows it, which is
 * what this channel is for.
 */
describe('reading a run series journal over IPC', () => {
  registerAgentHandlers()
  const journal = (id: string): unknown => handlers.get('agent:journal')!({}, id)

  it('answers with the journal of the series the run belongs to, not the run', () => {
    // The distinction is the whole feature: run 4 asking for "the journal"
    // means the record of runs 1 through 4, kept under the series id.
    runs.set('run_4', { id: 'run_4', seriesId: 'run_1' })
    journals.set('run_1', '## Run 1\nBought two shares.')
    journals.set('run_4', 'should never be read')

    expect(journal('run_4')).toBe('## Run 1\nBought two shares.')
  })

  it('treats a first run as its own series', () => {
    // `seriesIdOf` falls back to the run id so nothing downstream has to
    // special-case the first run; this is that contract reaching the channel.
    runs.set('run_1', { id: 'run_1' })
    journals.set('run_1', '## Run 1\nBought two shares.')

    expect(journal('run_1')).toBe('## Run 1\nBought two shares.')
  })

  it('is null for a run that no longer exists rather than an error', () => {
    // A panel asking about a run the user just deleted is a race, not a fault.
    expect(journal('run_gone')).toBeNull()
  })

  it('is null for a run whose series has written nothing yet', () => {
    runs.set('run_fresh', { id: 'run_fresh' })
    expect(journal('run_fresh')).toBeNull()
  })
})
