// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { render } from '../../../test-utils/dom'
import { describe, expect, it, vi } from 'vitest'
import type { AgentRun } from '@shared/agentRun.types'
import { SubAgentChips } from '../AgentRunConversation'

/**
 * The chips beside a run's title, one per sub-agent it sent out.
 *
 * Mostly markup, so this covers only the two things that can actually be
 * wrong: whether clicking one opens the run it names, and whether it says what
 * that sub-agent is doing. Both are the whole point of the control.
 */

function child(id: string, overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id,
    goal: 'check the auth module',
    delegatedTask: 'check the auth module',
    parentRunId: 'parent',
    status: 'running',
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
    conversationId: `conv-${id}`,
    summary: null,
    lastError: null,
    requirePlan: false,
    plan: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('SubAgentChips', () => {
  it('shows nothing for a run that delegated nothing', () => {
    const { container } = render(<SubAgentChips subAgents={[]} onOpenRun={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })

  it('opens the sub-agent whose mark was clicked', () => {
    const onOpenRun = vi.fn()
    render(
      <SubAgentChips
        subAgents={[child('run-a'), child('run-b'), child('run-c')]}
        onOpenRun={onOpenRun}
      />
    )

    fireEvent.click(screen.getByLabelText(/Open Bravo/))
    expect(onOpenRun).toHaveBeenCalledWith('run-b')
  })

  it('names the marks to match the report the parent read back', () => {
    // `renderReports` heads each section "Bravo", so the name is what takes a
    // reader from that line to the transcript behind it.
    render(<SubAgentChips subAgents={[child('run-a'), child('run-b')]} onOpenRun={vi.fn()} />)

    expect(screen.getByLabelText(/Open Alpha/).textContent).toBe('Alpha')
    expect(screen.getByLabelText(/Open Bravo/).textContent).toBe('Bravo')
  })

  it('gives each sub-agent a mark of a different shape', () => {
    // Colour alone would carry identity for most people and none of it for a
    // reader who cannot separate the hues — and once they all finish, the
    // colours converge on green and stop distinguishing anything at all.
    const { container } = render(
      <SubAgentChips
        subAgents={[child('run-a'), child('run-b'), child('run-c')]}
        onOpenRun={vi.fn()}
      />
    )

    const petals = [...container.querySelectorAll('svg')].map(
      (svg) => svg.querySelectorAll('circle').length
    )
    expect(petals).toEqual([4, 6, 8])
  })

  it('names the task on hover, so "what is it doing" needs no click', () => {
    render(
      <SubAgentChips
        subAgents={[child('run-a', { delegatedTask: 'search the parser for off-by-ones' })]}
        onOpenRun={vi.fn()}
      />
    )

    expect(screen.getByLabelText(/Open Alpha/).title).toContain('search the parser for off-by-ones')
  })

  it('carries each sub-agent’s own status, not just the fact it exists', () => {
    render(
      <SubAgentChips
        subAgents={[child('run-a', { status: 'error' }), child('run-b', { status: 'done' })]}
        onOpenRun={vi.fn()}
      />
    )

    expect(screen.getByLabelText(/Open Alpha/).getAttribute('aria-label')).toMatch(/error/i)
    expect(screen.getByLabelText(/Open Bravo/).getAttribute('aria-label')).toMatch(/done/i)
  })
})
