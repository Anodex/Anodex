// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { render } from '../../../test-utils/dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun } from '@shared/agentRun.types'

const readJournal = vi.fn<(runId: string) => Promise<string | null>>()

vi.mock('../../../lib/anodex', () => ({
  anodex: { agent: { journal: (runId: string) => readJournal(runId) } }
}))

const { JournalBlock } = await import('../AgentRunConversation')

/**
 * The journal panel in a run's log.
 *
 * The journal was kept as plain Markdown so the person whose agent it is can
 * read it; this is the half of that promise the app is responsible for. What
 * can actually be wrong is narrow: whether it appears at all, whether opening
 * it shows the text, and whether a run that finishes re-reads the file it just
 * appended to.
 */

function runOf(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run_2',
    goal: 'Track the portfolio',
    delegatedTask: null,
    parentRunId: null,
    seriesId: 'run_1',
    status: 'done',
    projectId: null,
    enabledTools: [],
    provider: 'local',
    model: null,
    maxTurns: 8,
    turnsUsed: 1,
    flaggedTurns: 0,
    maxTokens: 50_000,
    tokensUsed: 0,
    maxDurationMinutes: 30,
    activeMs: 0,
    activeSinceAt: null,
    limitsEnabled: true,
    conversationId: 'conv',
    summary: null,
    lastError: null,
    requirePlan: false,
    plan: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as AgentRun
}

describe('the journal block', () => {
  beforeEach(() => {
    readJournal.mockReset()
  })

  it('shows nothing at all when the series has written no journal', async () => {
    // Not an empty panel saying "no history": a run with nothing behind it
    // should look like a run, not like a feature that failed to load.
    readJournal.mockResolvedValue(null)
    const { container } = render(<JournalBlock run={runOf()} />)

    await waitFor(() => expect(readJournal).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })

  it('stays collapsed until asked, then shows what came before', async () => {
    readJournal.mockResolvedValue('## Run 1\nBought two shares of AAPL.')
    render(<JournalBlock run={runOf()} />)

    const toggle = await screen.findByRole('button', { name: /what this work has done so far/i })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(/Bought two shares/)).toBeNull()

    fireEvent.click(toggle)
    expect(screen.getByText(/Bought two shares/)).toBeTruthy()
  })

  it('re-reads when the run finishes, because finishing is what writes the entry', async () => {
    // Read once at mount and never again and the panel would show the journal
    // as it was at kickoff, permanently missing the run you are looking at.
    readJournal.mockResolvedValue('## Run 1\nBought two shares of AAPL.')
    const { rerender } = render(<JournalBlock run={runOf({ status: 'running' })} />)
    await waitFor(() => expect(readJournal).toHaveBeenCalledTimes(1))

    rerender(<JournalBlock run={runOf({ status: 'done' })} />)
    await waitFor(() => expect(readJournal).toHaveBeenCalledTimes(2))
  })

  it('shows nothing when the journal cannot be read', async () => {
    // A failure here must not take the run log down with it. The log is the
    // record of an unattended run, which is the thing actually worth reading.
    readJournal.mockRejectedValue(new Error('userData is gone'))
    const { container } = render(<JournalBlock run={runOf()} />)

    await waitFor(() => expect(readJournal).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
})
